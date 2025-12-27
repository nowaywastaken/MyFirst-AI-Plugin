// =================配置区域=================
// const API_KEY = '...'; // Removed: use storage instead
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// =========================================

// 全局状态 (内存中保留一份副本，但以此为准)
// =========================================
// 0. 初始化：防止“假死” (每次插件重载都强制重置)
// =========================================
chrome.runtime.onInstalled.addListener(async () => {
    // 0. 初始化基础状态
    chrome.storage.local.set({ 
        "agentState": { active: false, stepInfo: "🚀 扩展已就绪", waitingForLoad: false, actionHistory: [] }
    });
    
    // 🔌 Migration Logic (V1 Array -> V2 Split)
    // Check if we need migration
    const { userScripts } = await chrome.storage.local.get("userScripts");
    if (userScripts && userScripts.length > 0) {
        // Check if the first script has 'code' property directly
        if (typeof userScripts[0].code === 'string') {
            console.log("⚙️ Starting Storage Migration (V1 -> V2)...");
            const newMeta = [];
            const writes = {};
            
            for (const script of userScripts) {
                const codeKey = `ujs_${script.id}`;
                writes[codeKey] = script.code;
                
                // Create metadata object (without code)
                const { code, ...meta } = script;
                newMeta.push(meta);
            }
            
            writes["userScripts"] = newMeta;
            await chrome.storage.local.set(writes);
            console.log("✅ Storage Migration Completed!");
        }
    } else if (!userScripts) {
        // Initialize empty if not exists
        await chrome.storage.local.set({ "userScripts": [] });
    }

    chrome.alarms.clearAll();
});

// 每次 Service Worker 唤醒也检查一下（如果是异常唤醒）
// 但主要依赖 storage
let globalState = { active: false, stepInfo: "Ready", actionHistory: [] };

// 帮助函数：同步状态到 Storage
function saveState() {
  chrome.storage.local.set({ "agentState": globalState });
}

// 帮助函数：恢复状态
async function restoreState() {
  const data = await chrome.storage.local.get("agentState");
  if (data.agentState) {
    globalState = data.agentState;
  }
}

// 初始化时尝试恢复
restoreState();

// 1. 监听来自 Popup 的指令
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "START_TASK") {
    console.log("收到新任务:", request);
    
    globalState = {
      active: true,
      tabId: request.tabId,
      userPrompt: request.prompt,
      stepInfo: "Starting analysis...",
      waitingForLoad: false,
      actionHistory: [],
      lastPrompt: request.prompt // 📝 记住这个 Prompt 方便重试
    };
    saveState(); // 💾 保存

    runAgentLoop();
    sendResponse({ status: "ok" });
  }

  if (request.type === "STOP_TASK") {
      console.log("🛑 任务终止");
      globalState.active = false;
      globalState.stepInfo = "⛔️ 任务已由用户终止";
      globalState.waitingForLoad = false;
      saveState();
      
      // 清理所有闹钟
      chrome.alarms.clearAll();

      // 通知 Overlay 变红 (如果 Tab 还在的话)
      chrome.tabs.sendMessage(globalState.tabId, { type: "UPDATE_OVERLAY", text: globalState.stepInfo }).catch(()=>{});
      sendResponse({ status: "stopped" });
  }

  // Popup 可以轮询这个接口获取状态
  if (request.type === "GET_STATUS") {
    // 优先从 storage 读取最新状态返回，或者直接回内存状态
    // 为防万一，先读一下
    chrome.storage.local.get("agentState", (data) => {
        sendResponse(data.agentState || globalState);
    });
    return true; // 异步返回
  }

  // 🔌 生成脚本
  if (request.type === "GENERATE_SCRIPT") {
      handleScriptGeneration(request.tabId, request.url, request.prompt)
          .then(() => sendResponse({ status: "ok" }))
          .catch(err => sendResponse({ status: "error", error: err.message }));
      return true;
  }
  
  // 🔌 修复脚本
  if (request.type === "REPAIR_SCRIPT") {
      handleScriptRepair(request.tabId, request.scriptId, request.complaint)
          .then(() => sendResponse({ status: "ok" }))
          .catch(err => sendResponse({ status: "error", error: err.message }));
      return true;
  }
});

// ==========================================
// 🔌 脚本生成逻辑 & 修复逻辑
// ==========================================
async function handleScriptRepair(tabId, scriptId, complaint) {
    // 1. Get Script
    const { userScripts } = await chrome.storage.local.get("userScripts");
    const scriptIdx = userScripts.findIndex(s => s.id === scriptId);
    if (scriptIdx === -1) throw new Error("Script not found");
    const script = userScripts[scriptIdx];

    // 2. Get Page Context
    let pageData = { text: "" };
    try {
        const result = await chrome.scripting.executeScript({ target: { tabId }, function: analyzePageElements });
        pageData = result[0].result;
    } catch (e) { console.error("Analysis failed", e); }

    // 3. Prompt
    const prompt = `
    Context:
    This is an existing Tampermonkey-style script that is failing or needs update.
    Current Code: 
    \`\`\`javascript
    ${script.code}
    \`\`\`
    
    User Complaint: "${complaint}"
    
    New Page Structure (Current State):
    Page Text (snippet): ${pageData.text.substring(0, 1000)}
    Inputs/Buttons: ${JSON.stringify(pageData.inputs).substring(0, 1000)}
    
    Task: Analyze why the script might fail (e.g. selectors changed) and write a FIXED version.
    
    Return ONLY a JSON object:
    {
      "code": "new fixed code",
      "explanation": "what was fixed"
    }
    `;

    // 4. AI
    const aiResp = await callAI(prompt, "json_object");
    const jsonMatch = aiResp.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI returned invalid JSON");
    const data = JSON.parse(jsonMatch[0]);

    // 5. Update with Versioning (Split Storage)
    // Fetch full script code first because 'script' here is just metadata (if coming from UI list)
    // OR if coming from internal flow it might not have code yet.
    // Actually handleScriptRepair is called with scriptId.
    
    // Re-fetch to be safe
    const { userScripts: currentScripts } = await chrome.storage.local.get("userScripts");
    const freshScriptIdx = currentScripts.findIndex(s => s.id === scriptId);
    if (freshScriptIdx === -1) throw new Error("Script gone");
    
    let freshScript = currentScripts[freshScriptIdx];
    
    // Get old code to save in history
    const oldCodeMap = await chrome.storage.local.get(`ujs_${scriptId}`);
    const oldCode = oldCodeMap[`ujs_${scriptId}`] || "";

    if (!freshScript.history) freshScript.history = [];
    freshScript.history.push({ 
        code: oldCode, 
        timestamp: Date.now(), 
        reason: "Before Repair: " + complaint 
    });
    
    freshScript.updatedAt = Date.now();
    
    // Save Code separately
    const writes = {};
    writes[`ujs_${scriptId}`] = data.code;
    
    // Update Metadata
    currentScripts[freshScriptIdx] = freshScript;
    writes["userScripts"] = currentScripts;
    
    await chrome.storage.local.set(writes);
    
    return true;
}

async function handleScriptGeneration(tabId, url, userPrompt) {
    // 0. Inject Tools (ALL FRAMES)
    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ["lib/dom_tools.js"]
        });
    } catch (e) { console.error("Tool injection failed", e); }

    // 1. Initial Analysis (Quick overview)
    let pageData = { text: "" };
    try {
        const result = await chrome.scripting.executeScript({ target: { tabId }, function: analyzePageElements });
        pageData = result[0].result;
    } catch (e) { console.error("Analysis failed", e); }

    // 1.5. Get Existing Context
    const { userScripts } = await chrome.storage.local.get("userScripts");
    const existingList = (userScripts || []).map(s => `- ${s.name} (Matches: ${s.matches})`).join("\n");

    // === INTERACTIVE LOOP ===
    const MAX_TURNS = 50; 
    let history = [];
    let recentActions = []; // Queue for loop detection (size 3)
    let finalCode = "";
    let finalExplanation = "";

    for (let i = 0; i < MAX_TURNS; i++) {
        console.log(`🔄 Turn ${i + 1}/${MAX_TURNS}`);
        
        // --- 1. Token Safety: Truncate History if too long ---
        // Naive estimation: 1 char ~= 0.25 tokens (conservative), or just char count limits.
        // Let's keep total prompt reasonable (< 12000 chars approx 3k tokens + overhead)
        const historyChars = history.reduce((acc, h) => acc + h.content.length, 0);
        if (historyChars > 12000) {
            // Remove roughly top 20% of history (skipping first few if possible, but keep it simple)
            // Just splice the middle
             const removeCount = Math.floor(history.length * 0.2);
             if (removeCount > 0) {
                 history.splice(1, removeCount, { role: "system", content: `[... Removed ${removeCount} earlier steps to save memory ...]` });
             }
        }

        // --- 2. Construct Prompt ---
        const prompt = `
        Context:
        URL: ${url}
        Page Title: ${pageData.title || "Unknown"}
        Initial Text Snippet: ${pageData.text.substring(0, 500)}...
        
        Task: Create a Tampermonkey-style Javascript script to: "${userPrompt}"
        
        Tools Available:
        - SEARCH_TEXT(query): Find elements containing text. Returns list with classes/IDs.
        - INSPECT_SELECTOR(selector): Get details (HTML/parent) of a specific selector.
        - FINISH(code, explanation): Submit the final script.
        
        History:
        ${history.map(h => `[${h.role}]: ${h.content}`).join("\n")}
        
        Instructions:
        1. If you don't know the exact class name for ads or elements, use SEARCH_TEXT first!
        2. Inspect candidates to verify structure before writing code.
        3. Even if you think you know, verify.
        4. Return ONLY a JSON object:
        {
            "tool": "SEARCH_TEXT" | "INSPECT_SELECTOR" | "FINISH",
            "arg": "search_query_or_selector",
            "code": "final_code_if_finish", 
            "explanation": "thought_process"
        }
        `;

        // Call AI
        const aiResp = await callAI(prompt, "json_object");
        console.log("AI Resp:", aiResp);
        
        let action;
        try {
            const jsonMatch = aiResp.match(/\{[\s\S]*\}/);
            action = JSON.parse(jsonMatch[0]);
        } catch (e) {
            console.error("JSON Parse Error", e);
            history.push({ role: "system", content: "Error: Invalid JSON format. Please try again." });
            continue;
        }

        // --- 3. Loop Detection ---
        const actionSig = `${action.tool}:${action.arg}`;
        recentActions.push(actionSig);
        if (recentActions.length > 3) recentActions.shift();

        // Check if last 3 actions are identical
        if (recentActions.length === 3 && recentActions.every(s => s === actionSig) && action.tool !== "FINISH") {
             console.warn("⚠️ Loop detected!", actionSig);
             history.push({ role: "system", content: "WARNING: You are repeating the same action repeatedly. Try a different query, or use FINISH if you are stuck." });
             // Do not execute tool, just feedback
             continue;
        }

        // Execute Tool
        if (action.tool === "FINISH") {
            finalCode = action.code;
            finalExplanation = action.explanation;
            break;
        } else if (action.tool === "SEARCH_TEXT") {
            // Updated to scan ALL FRAMES
            const res = await chrome.scripting.executeScript({
                target: { tabId, allFrames: true },
                func: (q) => window.tool_search_text(q),
                args: [action.arg]
            });
            
            // Rewrite standard output to combine frames
            // res is array: [{frameId: 0, result: ...}, {frameId: 123, result: ...}]
            let combinedResults = [];
            res.forEach(frameRes => {
                if (frameRes.result && frameRes.result.results && frameRes.result.results.length > 0) {
                    frameRes.result.results.forEach(item => {
                        item.frameId = frameRes.frameId; // Tag result with frame
                        combinedResults.push(item);
                    });
                }
            });
            
            history.push({ role: "assistant", content: `Tool: SEARCH_TEXT("${action.arg}")` });
            history.push({ role: "system", content: `Found ${combinedResults.length} matches in ${res.length} frames:\n${JSON.stringify(combinedResults).substring(0, 3000)}` }); 
        } else if (action.tool === "INSPECT_SELECTOR") {
            const res = await chrome.scripting.executeScript({
                target: { tabId },
                func: (s) => window.tool_inspect_selector(s),
                args: [action.arg]
            });
            const output = res[0].result;
            history.push({ role: "assistant", content: `Tool: INSPECT_SELECTOR("${action.arg}")` });
            history.push({ role: "system", content: `Result: ${JSON.stringify(output).substring(0, 1500)}` });
        } else {
             history.push({ role: "system", content: "Error: Unknown tool. Use SEARCH_TEXT, INSPECT_SELECTOR, or FINISH." });
        }
    }


    
    // Fallback: If no code generated after max turns, Force Finish.
    if (!finalCode) {
        console.warn("⚠️ Max turns reached. Forcing conclusion.");
        const forcePrompt = `
        You have run out of turns.
        Based on the history above, generate the BEST POSSIBLE script now.
        Do not ask for more info.
        Return ONLY JSON with "tool": "FINISH".
        `;
        
        try {
            const aiResp = await callAI(forcePrompt + "\nHistory:\n" + history.map(h => `[${h.role}]: ${h.content}`).join("\n"), "json_object");
            const jsonMatch = aiResp.match(/\{[\s\S]*\}/);
            const action = JSON.parse(jsonMatch[0]);
            if (action.tool === "FINISH") {
                finalCode = action.code;
                finalExplanation = action.explanation || "Forced generation after timeout";
            }
        } catch(e) { console.error("Force finish failed", e); }
    }

    if (!finalCode) {
        throw new Error("AI failed to generate code even after forced finish.");
    }
    
    // 4. Save to Storage (Split)
    const { userScripts: currentScripts } = await chrome.storage.local.get("userScripts");
    const newScripts = currentScripts || [];
    
    const scriptId = crypto.randomUUID();
    const newScriptMeta = {
        id: scriptId,
        name: finalExplanation ? finalExplanation.substring(0, 20) : "AI Script",
        matches: url.split('?')[0] + "*", 
        enabled: true,
        createdAt: Date.now()
    };
    
    newScripts.push(newScriptMeta);
    
    const writes = {};
    writes["userScripts"] = newScripts;
    writes[`ujs_${scriptId}`] = finalCode;
    
    await chrome.storage.local.set(writes);
    
    // 5. Run Immediately
    chrome.scripting.executeScript({
        target: { tabId },
        func: (code) => {
             const scriptEl = document.createElement('script');
             scriptEl.textContent = code;
             (document.head || document.documentElement).appendChild(scriptEl);
             scriptEl.remove();
        },
        args: [finalCode],
        world: "MAIN"
    }).catch(e => console.error("Immediate run failed", e));
    
    return true;
}

// 2. 监听页面加载完成 (用于跨页面任务)
// 2. 监听页面加载 (Faster Injection: document_start)
// Using webNavigation.onCommitted to inject as early as possible
chrome.webNavigation.onCommitted.addListener(async (details) => {
    // Only inject into the main frame for now (frameId 0)
    // To support iframes, we would need to check match patterns against details.url
    if (details.frameId !== 0) return;

    try {
        const { userScripts } = await chrome.storage.local.get("userScripts");
        if (userScripts && userScripts.length > 0) {
            const matchedScripts = userScripts.filter(script => {
                if (!script.enabled) return false;
                // Simple wildcard matching
                const pattern = script.matches.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
                const regex = new RegExp(`^${pattern}$`);
                return regex.test(details.url);
            });

            if (matchedScripts.length > 0) {
                console.log(`⚡️ [FastInject] Found ${matchedScripts.length} scripts for ${details.url}`);
                
                // Load codes
                const keys = matchedScripts.map(s => `ujs_${s.id}`);
                const codeMap = await chrome.storage.local.get(keys);
                
                matchedScripts.forEach(script => {
                    const code = codeMap[`ujs_${script.id}`];
                    if (!code) return;

                    chrome.scripting.executeScript({
                        target: { tabId: details.tabId },
                        func: (code) => {
                            try {
                                const scriptEl = document.createElement('script');
                                scriptEl.textContent = code;
                                // Inject immediately
                                (document.head || document.documentElement).appendChild(scriptEl);
                                scriptEl.remove();
                            } catch(e) { console.error("Script Error:", e); }
                        },
                        args: [code],
                        world: "MAIN",
                        injectImmediately: true // Key for document_start emulation
                    }).catch(err => console.error("Injection failed:", err));
                });
            }
        }
    } catch (e) { console.error("Script Check Error:", e); }
});

// onUpdated 仅用于 UI 状态维护 (Overlay) 和 Agent 逻辑
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
      // 🔌 scripts are now injected via webNavigation (Phase 1 Task 3)
      
      // B. 🤖 AI Agent 恢复逻辑
      // Service Worker 恢复
      if (!globalState.active) {
          const data = await chrome.storage.local.get("agentState");
          if (data.agentState) {
              globalState = data.agentState;
          }
      }

      // 只要 loading 结束，不管是不是我们的任务 tab，都先检查一下
      if (globalState.active && tabId === globalState.tabId) {
        
        // 🚑 关键修复：页面一加载完，马上注入 Overlay，不管是否 waiting
        try {
            await chrome.scripting.executeScript({
                target: { tabId: globalState.tabId },
                files: ["content.js"]
            });
            // 恢复显示之前的状态
            chrome.tabs.sendMessage(globalState.tabId, { type: "UPDATE_OVERLAY", text: globalState.stepInfo }).catch(()=>{});
        } catch (e) { }

        if (globalState.waitingForLoad) {
          console.log("页面加载完成，继续执行任务...");
          
          // 更新状态让用户看见
          globalState.stepInfo = "👀 页面加载完毕，正在观察...";
          saveState();
          chrome.tabs.sendMessage(globalState.tabId, { type: "UPDATE_OVERLAY", text: globalState.stepInfo }).catch(()=>{});

          globalState.waitingForLoad = false;
          saveState(); 
          
          chrome.alarms.create("continueLoop", { when: Date.now() + 1000 });
        }
      }
  }
});


// 核心循环：分析 -> 思考 -> 执行
async function runAgentLoop() {
  if (!globalState.active) return;

  // 防止无限递归
  if (globalState.actionHistory.length > 20) {
      updateOverlay("❌ 任务步骤过多，强制停止防止死循环。");
      // updateOverlay("❌ 任务步骤过多，强制停止防止死循环。"); // Cannot call updateOverlay here, it's defined later
      globalState.stepInfo = "❌ 任务步骤过多，强制停止防止死循环。";
      saveState();
      return;
  }

  try {
    // 0. 注入悬浮窗 - 已经在 onUpdated 做过，这里是双保险
    try { await chrome.scripting.executeScript({ target: { tabId: globalState.tabId }, files: ["content.js"] }); } catch (e) { }

    const updateOverlay = (text) => {
        globalState.stepInfo = text;
        saveState();
        chrome.tabs.sendMessage(globalState.tabId, { type: "UPDATE_OVERLAY", text: text }).catch(() => {});
    };

    updateOverlay("👀 侦察兵正在分析战场...");
    
    // === 第一步：扫描全场 (检测 URL 安全性) ===
    let pageData = { text: "", inputs: [], buttons: [] };
    
    let tabObj;
    try {
        tabObj = await chrome.tabs.get(globalState.tabId);
    } catch(e) {
        // Tab 可能关了
        globalState.active = false;
        saveState();
        return;
    }
    
    const restricted = tabObj.url.startsWith("chrome://") || tabObj.url.startsWith("edge://") || tabObj.url.startsWith("about:") || tabObj.url.startsWith("view-source:");

    if (restricted) {
         updateOverlay("⚠️ 受限页面，准备跳转...");
         pageData.text = "【系统】：当前页面受限，请立即 Navigate 跳转。";
    } else {
        // 正常注入
        try {
            const result = await chrome.scripting.executeScript({ target: { tabId: globalState.tabId }, function: analyzePageElements });
            pageData = result[0].result;
        } catch (scriptErr) {
            console.error("Script injection failed:", scriptErr);
            // 可能是还没加载完，或者权限问题。稍微歇一下再试
            updateOverlay("⏳ 页面未就绪，重试中...");
            chrome.alarms.create("retryLoop", { when: Date.now() + 2000 });
            return;
        }

        // Retry logic
        if (pageData.inputs.length === 0 && pageData.buttons.length < 2) {
             updateOverlay("⏳ 等待页面内容加载...");
             // 使用 Alarm 代替 sleep
             // 这里我们不能 await alarm，所以我们 schedule 一个 alarm 然后结束当前 Loop
             // 但为了保持 runAgentLoop 的线性逻辑（简单起见），我们这里用 await new Promise 还是可以的
             // 前提是这个 Promise 不要太长（超过30秒 service worker 会挂）
             // 2秒是可以接受的
             await new Promise(r => setTimeout(r, 2000));
             
             // 二次尝试
             try {
                 const res2 = await chrome.scripting.executeScript({ target: { tabId: globalState.tabId }, function: analyzePageElements });
                 pageData = res2[0].result;
             } catch(e) {}
        }
    }

    // === 第二步：制定作战计划 ===
    updateOverlay("🧠 AI 正在思考...");

    const uiContext = JSON.stringify({ inputs: pageData.inputs, buttons: pageData.buttons });
    const memoryData = await chrome.storage.local.get(["userMemory"]);
    const userMemory = memoryData.userMemory || "（无）";

    // 📜 构建历史
    const historyText = globalState.actionHistory.map((h, i) => `${i+1}. ${h.thought} -> ${JSON.stringify(h.action)}`).join("\n");

    const fullPrompt = `
      【网页文本】：${pageData.text}
      【UI元素】：${uiContext}
      【记忆】：${userMemory}
      【历史】：
      ${historyText || "(无)"}
      
      【任务】：${globalState.userPrompt}
      
      【逻辑】：
      1. 如果页面不对，请 navigate。
      2. 优先点击最可能的元素。
      3. 绝对不要重复失败的操作。
      
      【输出 JSON】：
      {
        "thought": "Thinking...",
        "status": "continue" | "finish",
        "action": { "navigate": "url", "fill": {id:val}, "click": "id" },
        "message": "feedback"
      }
    `;

    const aiResponseText = await callAI(fullPrompt);

    console.log("AI Plan Raw:", aiResponseText);

    // 尝试提取 JSON 对象 (寻找最外层的 {})
    const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
         throw new Error("AI 响应格式错误 (No JSON found)");
    }

    const cleanJson = jsonMatch[0];
    let plan;
    try {
        plan = JSON.parse(cleanJson);
    } catch (parseErr) {
        console.error("JSON Parse Error:", parseErr, "Cleaned JSON:", cleanJson);
        throw parseErr; // 重新抛出给外层 Catch 显示
    }

    // === 第三步：执行 ===
    if (plan.status === "finish") {
      updateOverlay("✅ " + (plan.message || "Done"));
      globalState.active = false;
      saveState();
      return;
    }

    globalState.actionHistory.push({ thought: plan.thought, action: plan.action });
    saveState();
    updateOverlay("⚡️ " + plan.thought);

    if (plan.action) {
        if (plan.action.navigate) {
            updateOverlay("🚀 前往: " + plan.action.navigate);
            globalState.waitingForLoad = true;
            saveState();
            await chrome.tabs.update(globalState.tabId, { url: plan.action.navigate });
            return;
        }

      if (!restricted) {
          await chrome.scripting.executeScript({ target: { tabId: globalState.tabId }, function: executeActionPlan, args: [plan.action] });
      }
      
      if (plan.action.click) {
        globalState.waitingForLoad = true;
        updateOverlay("⏳ 点击完成，等待跳转...");
        saveState();
        
        // ⏰ 使用 Alarm 做超时检测，而不是 setTimeout
        chrome.alarms.create("checkNavigationTimeout", { delayInMinutes: 0.15 }); // ~9秒后
      } else {
        // 下一步
        chrome.alarms.create("nextStep", { when: Date.now() + 1000 });
      }
    } else {
       globalState.active = false;
       updateOverlay("❓ AI 停止运行。");
       saveState();
    }

  } catch (err) {
    console.error(err);
    chrome.tabs.sendMessage(globalState.tabId, { type: "UPDATE_OVERLAY", text: "❌ Error: " + err.message }).catch(()=>{});
    globalState.active = false;
    saveState();
  }
}

// ⏰ 监听 Alarm
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "nextStep" || alarm.name === "retryLoop" || alarm.name === "continueLoop") {
        runAgentLoop();
    }
    if (alarm.name === "checkNavigationTimeout") {
        if (globalState.active && globalState.waitingForLoad) {
            console.log("⏰ 导航超时，强制继续...");
            globalState.waitingForLoad = false;
            saveState();
            runAgentLoop();
        }
    }
});

// ==========================================
// 🕵️‍♂️ 侦察兵 (加强版：找搜索结果)
// ==========================================
function analyzePageElements() {
  const bodyText = document.body.innerText;
  
  // 简易的“等待”逻辑在 content script 里不好做同步 sleep
  // 所以我们只负责准确抓取。如果抓不到，Background 会决定是否重试。

  const inputEls = document.querySelectorAll('input, textarea');
  const inputList = [];
  inputEls.forEach((el) => {
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'image' || el.disabled) return;
    // 增加可见性判断：如果 display:none 或者 visibility:hidden，忽略
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    
    inputList.push({
        key: el.name || el.id || ("idx_" + inputList.length), 
        placeholder: el.placeholder || "",
        label: el.previousElementSibling?.innerText || "" 
    });
  });

  const btnList = [];
  
  // 1. 标准按钮
  document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, div[role="button"]').forEach((el, index) => {
    // 必须有 offsetParent 才是可见的
    if (el.offsetParent === null) return; 
    
    let btnText = el.innerText || el.value || el.title || "";
    btnText = btnText.substring(0, 20).replace(/\n/g, "");
    if(btnText.trim().length < 1) return; 

    btnList.push({
        key: el.id || el.name || ("btn_idx_" + index), 
        text: btnText
    });
  });

  // 2. 🔍 重点：搜索结果链接 (通常在 h3 里面)
  document.querySelectorAll('h3 a, h3').forEach((el, index) => {
      // 这里的逻辑稍微宽泛一点，把 h3 里的文字当按钮
      let aTag = el.tagName === 'A' ? el : el.querySelector('a');
      let t = el.innerText.substring(0, 50).replace(/\n/g, "");
      if(t.trim().length > 0) {
          // 如果是 a 标签，最好用 href 做 key 的一部分防止重复? 不用了，还是用 dom 索引稳妥
          btnList.push({ 
              key: "link_res_" + index, // 特殊前缀
              text: "[搜索结果] " + t,
              isResult: true, // 标记一下给 AI 看
              selector: aTag ? "" : "h3_parent" // 标记是否需要特殊处理
          });
      }
  });

  return {
    text: bodyText.substring(0, 2000), // 稍微缩短一点，给 Context 留空间
    inputs: inputList,
    buttons: btnList.slice(0, 60) // 多给点额度
  };
}

// ==========================================
// ⚡️ 执行者 (加强版：支持复杂选择器)
// ==========================================
function executeActionPlan(action) {
  if (action.fill) {
    for (const [key, value] of Object.entries(action.fill)) {
      let el = document.querySelector(`[name="${key}"], #${key}`);
      if (!el && key.startsWith("idx_")) {
          // 这里的 idx 逻辑其实不太稳，但在 demo 里先凑合
          // 背景脚本里没存 idx 映射，所以这里最好是重新 query 一遍然后按顺序
          // 但 analyzePageElements 是每一次 run loop 都跑的，所以顺序应该差不多
          let idx = parseInt(key.split("_")[1]);
          let all = document.querySelectorAll('input, textarea');
          let list = [];
          all.forEach(e => {
            const style = window.getComputedStyle(e);
            if (!(e.type === 'hidden' || e.type === 'submit' || e.type === 'button' || e.disabled) && style.display !== 'none') list.push(e);
          });
          el = list[idx];
      }

      if (el) {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true })); // extra event
          el.style.backgroundColor = "#e8f0fe"; 
      }
    }
  }

  if (action.click) {
      let btn = null;
      
      // A. ID/Name match
      btn = document.getElementById(action.click) || document.querySelector(`[name="${action.click}"]`);
      
      // B. Link Result match (link_res_X)
      if (!btn && action.click.startsWith("link_res_")) {
          let idx = parseInt(action.click.split("_")[2]);
          let allH3 = document.querySelectorAll('h3 a, h3');
          let target = allH3[idx];
          if (target) {
              btn = target.tagName === 'A' ? target : target.querySelector('a');
              if (!btn) btn = target; // Fallback to clicking H3 itself
          }
      }

      // C. Button Index match (btn_idx_X)
      if (!btn && action.click.startsWith("btn_idx_")) {
         let idx = parseInt(action.click.split("_")[2]);
         // 必须用同样的逻辑重选一遍
         let allBtns = document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, div[role="button"]');
         let visibleBtns = [];
         allBtns.forEach(b => {
             if (b.offsetParent !== null && (b.innerText || b.value || b.title || "").trim().length > 0) visibleBtns.push(b);
         });
         btn = visibleBtns[idx];
      }

      if (btn) {
          console.log("点击:", btn);
          btn.style.border = "3px solid red"; 
          btn.style.backgroundColor = "yellow";
          btn.scrollIntoView({ behavior: "smooth", block: "center" });
          
          setTimeout(() => {
            btn.click();
          }, 300); // 稍微看清楚一点再点
      }
  }
}

// ==========================================
// 🧠 AI (复用)
// ==========================================
async function callAI(prompt, format = "json_object") {
  const { apiKey, providerUrl, modelName } = await chrome.storage.local.get(["apiKey", "providerUrl", "modelName"]);
  
  if (!apiKey) {
      throw new Error("❌ 未配置 API Key。请点击右上角⚙️图标进行设置。");
  }
  
  const API_ENDPOINT = providerUrl || "https://openrouter.ai/api/v1/chat/completions";
  const MODEL_ID = modelName || "google/gemini-2.5-flash";

  const response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://localhost:3000",
    },
    body: JSON.stringify({
      model: MODEL_ID,
      response_format: { type: format }, 
      messages: [
        { role: "system", content: "你是一个自动化操作助手。请输出纯 JSON。" },
        { role: "user", content: prompt }
      ]
    })
  });
  
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}
