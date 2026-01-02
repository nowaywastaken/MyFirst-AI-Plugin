// =================Configuration=================
// API Key is stored in chrome.storage.local
// ================================================

// Security: Validate AI-generated code before execution
function validateCodeSafety(code) {
    const dangerousPatterns = [
        // Code execution
        /\beval\s*\(/i,
        /\bnew\s+Function\s*\(/i,
        /setTimeout\s*\(\s*['"`]/i,  // String-based setTimeout
        /setInterval\s*\(\s*['"`]/i, // String-based setInterval
        
        // Data access
        /document\.cookie/i,
        /localStorage\.getItem\s*\(['"]apiKey['"]\)/i,
        /chrome\.storage/i,
        /sessionStorage/i,
        /indexedDB/i,
        
        // Network exfiltration
        /\bfetch\s*\(['"](?!https?:\/\/)/i,  // Relative fetch
        /XMLHttpRequest/i,
        /navigator\.sendBeacon/i,
        /WebSocket/i,
        
        // DOM injection
        /<script[^>]*src\s*=/i,
        /document\.write/i,
        /insertAdjacentHTML/i,
        
        // Window operations (phishing risk)
        /window\.open\s*\(/i,
        /window\.location\s*=/i,
    ];
    
    const warnings = [];
    for (const pattern of dangerousPatterns) {
        if (pattern.test(code)) {
            warnings.push(`Potentially dangerous pattern detected: ${pattern.toString()}`);
        }
    }
    
    return { safe: warnings.length === 0, warnings };
}

// Rate limiting for API calls
let lastApiCallTime = 0;
const API_MIN_INTERVAL_MS = 500; // Minimum 500ms between calls

// Helper: Create safe regex from URL match pattern
// ReDoS Protection: Pattern length limited to 500 chars
const MAX_PATTERN_LENGTH = 500;

function createMatchRegex(pattern) {
    try {
        // Fix: Validate pattern before processing
        if (!pattern || typeof pattern !== 'string' || pattern.trim().length === 0) {
            console.warn('Empty or invalid match pattern');
            return null;
        }
        // ReDoS protection: limit pattern length
        if (pattern.length > MAX_PATTERN_LENGTH) {
            console.warn('Pattern too long, potential ReDoS risk');
            return null;
        }
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${escaped}$`);
    } catch (e) {
        console.error('Invalid match pattern:', pattern, e);
        return null;
    }
}

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
    return true; // Fix: Allow async response
  }

  // 1.5 🧠 智能路由 (SMART_START)
  if (request.type === "SMART_START") {
      console.log("🧠 收到智能任务请求:", request);
      
      // 先告诉前端我们收到了，正在分析
      sendResponse({ status: "analyzing" });
      
      // 异步执行分析
      (async () => {
         try {
             let intent = "AGENT"; // Default
             
             // 1. Check Explicit Mode
             if (request.mode && request.mode !== "AUTO") {
                 intent = request.mode;
                 console.log(`🧐 用户指定模式: ${intent}`);
             } else {
                 // 2. Auto Determine
                 intent = await determineIntent(request.prompt);
                 console.log("🧐 自动分析意图:", intent);
             }
             
             if (intent === "SCRIPT") {
                 // 转去生成脚本 - Fix: Get actual URL from tab
                 const tab = await chrome.tabs.get(request.tabId);
                 await handleScriptGeneration(request.tabId, tab?.url || "*", request.prompt);
             } else {
                 // Agent Mode
                 globalState = {
                    active: true,
                    tabId: request.tabId,
                    userPrompt: request.prompt,
                    stepInfo: "Starting analysis (Agent Mode)...",
                    waitingForLoad: false,
                    actionHistory: [],
                    lastPrompt: request.prompt,
                    initialMode: intent // Store initial mode
                  };
                  saveState();
                  runAgentLoop();
             }
         } catch(e) {
             console.error("Intent determination failed", e);
             // Fallback to Agent
             globalState = {
                active: true,
                tabId: request.tabId,
                userPrompt: request.prompt,
                stepInfo: "Fallback to Agent Mode...", 
                waitingForLoad: false,
                actionHistory: [],
                lastPrompt: request.prompt
              };
              saveState();
              runAgentLoop();
         }
      })();
      return true; // async handling
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
      return true; // Fix: Ensure response channel stays open
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

  // 🔌 历史转脚本
  if (request.type === "CONVERT_HISTORY_TO_SCRIPT") {
      if (!globalState.actionHistory || globalState.actionHistory.length === 0) {
          sendResponse({ status: "error", error: "No history found" });
          return true;
      }
      
      // Fix: Use tabId from request if available, fallback to globalState
      const targetTabId = request.tabId || globalState.tabId;
      
      // Get current URL from the tab
      chrome.tabs.get(targetTabId, (tab) => {
          const currentUrl = tab?.url || "*";
          handleScriptGeneration(targetTabId, currentUrl, "Automate the steps I just did.", globalState.actionHistory)
              .then(() => sendResponse({ status: "ok" }))
              .catch(err => sendResponse({ status: "error", error: err.message }));
      });
      return true;
  }

  // 🔌 确认结果 (CONFIRM_RESULT)
  if (request.type === "CONFIRM_RESULT") {
      if (!globalState.waitingForConfirm) return;
      
      console.log("Confirmation Logic:", request.result);
      globalState.waitingForConfirm = false;
      saveState();

      if (request.result === true) {
          // YES -> Proceed to Script Generation
          chrome.tabs.sendMessage(globalState.tabId, { type: "UPDATE_OVERLAY", text: "✅ Confirmed. Switching..." });
          globalState.active = false;
          saveState();
          handleScriptGeneration(globalState.tabId, "URL", globalState.userPrompt, globalState.actionHistory);
      } else {
          // NO -> Continue as Agent
          // We need to tell the AI that script mode was rejected
          globalState.actionHistory.push({ 
              thought: "User rejected switching to script mode.", 
              action: { note: "Continue manually as Agent." } 
          });
          saveState();
          chrome.tabs.sendMessage(globalState.tabId, { type: "UPDATE_OVERLAY", text: "👌 Continuing as Agent..." });
          runAgentLoop();
      }
  }
});

// ==========================================
// 🧠 意图识别
// ==========================================
async function determineIntent(userPrompt) {
    const prompt = `
    User Prompt: "${userPrompt}"
    
    Task: Classify if this is a "One-off Task" (better for an Agent to just do it) or a "Reusable Modification" (better for a Script).
    
    Examples:
    - "Click the login button" -> AGENT
    - "Fill this form with my info" -> AGENT
    - "Find the cheapest price on this page" -> AGENT
    - "Always hide the sidebar" -> SCRIPT
    - "Make the font bigger" -> SCRIPT
    - "Auto-skip ads on this site" -> SCRIPT
    - "Download all images" -> AGENT (usually one-off) but could be SCRIPT if "Add a button to download all"
    
    Return ONLY a JSON object:
    {
      "intent": "AGENT" | "SCRIPT",
      "reason": "short explanation"
    }
    `;
    
    try {
        const resp = await callAI(prompt, "json_object");
        const jsonMatch = resp.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error("Intent check: No JSON found in response");
            return "AGENT";
        }
        const data = JSON.parse(jsonMatch[0]);
        return data.intent || "AGENT"; 
    } catch (e) {
        console.error("Intent check failed, defaulting to AGENT", e);
        return "AGENT";
    }
}
// ==========================================
// 🔌 脚本生成逻辑 & 修复逻辑
// ==========================================
async function handleScriptRepair(tabId, scriptId, complaint) {
    // 1. Get Script Metadata
    const { userScripts } = await chrome.storage.local.get("userScripts");
    const scriptIdx = userScripts.findIndex(s => s.id === scriptId);
    if (scriptIdx === -1) throw new Error("Script not found");
    const script = userScripts[scriptIdx];

    // 1.5. Get Script Code from storage (V2 Split Storage)
    const codeKey = `ujs_${scriptId}`;
    const codeData = await chrome.storage.local.get(codeKey);
    const currentCode = codeData[codeKey] || "// No code found";

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
    ${currentCode}
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
    // Fix: Use unshift to add newest first (consistent with options.js)
    freshScript.history.unshift({ 
        code: oldCode, 
        timestamp: Date.now(), 
        reason: "Before Repair: " + complaint 
    });
    // Limit history to prevent unbounded growth (keep newest 15)
    if (freshScript.history.length > 15) {
        freshScript.history = freshScript.history.slice(0, 15);
    }
    
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

async function handleScriptGeneration(tabId, url, userPrompt, contextHistory = []) {
    // 0. Inject Tools (ALL FRAMES) - Fix: Add error recovery
    let toolsInjected = false;
    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ["lib/dom_tools.js"]
        });
        toolsInjected = true;
    } catch (e) { 
        console.warn("Tool injection failed, will use basic analysis", e); 
    }

    // 1. Initial Analysis (Quick overview)
    let pageData = { text: "" };
    try {
        const result = await chrome.scripting.executeScript({ target: { tabId }, function: analyzePageElements });
        pageData = result[0].result;
    } catch (e) { console.error("Analysis failed", e); }
    
    // Fix: Get actual URL from tab if parameter is invalid
    let actualUrl = url;
    if (!url || url === "Current URL" || url === "URL") {
        try {
            const tab = await chrome.tabs.get(tabId);
            actualUrl = tab?.url || "*";
        } catch(e) {
            actualUrl = "*";
        }
    }

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
        URL: ${actualUrl}
        Page Title: ${pageData.title || "Unknown"}
        Initial Text Snippet: ${pageData.text.substring(0, 500)}...
        
        Task: Create a Tampermonkey-style Javascript script to: "${userPrompt}"
        
        Tools Available:
        - SEARCH_TEXT(query): Find elements containing text. Returns list with classes/IDs.
        - INSPECT_SELECTOR(selector): Get details (HTML/parent) of a specific selector.
        - FINISH(code, explanation): Submit the final script.
        
        History:
        ${contextHistory.length > 0 ? "PREVIOUS AGENT HISTORY (Use this to understand what to replicate):\n" + JSON.stringify(contextHistory) + "\n\nCURRENT SESSION:" : ""}
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
        matches: actualUrl.split('?')[0] + "*",  // Fix: Use actualUrl instead of url
        enabled: true,
        createdAt: Date.now()
    };
    
    newScripts.push(newScriptMeta);
    
    const writes = {};
    writes["userScripts"] = newScripts;
    writes[`ujs_${scriptId}`] = finalCode;
    
    await chrome.storage.local.set(writes);
    
    // 5. Validate code safety before execution - BLOCK if unsafe
    const safetyCheck = validateCodeSafety(finalCode);
    if (!safetyCheck.safe) {
        console.error("🚫 Code blocked due to safety issues:", safetyCheck.warnings);
        // Still save it but mark as disabled and DO NOT execute
        const { userScripts: blockedScripts } = await chrome.storage.local.get("userScripts");
        const blockedIdx = blockedScripts.findIndex(s => s.id === scriptId);
        if (blockedIdx !== -1) {
            blockedScripts[blockedIdx].enabled = false;
            blockedScripts[blockedIdx].blockedReason = safetyCheck.warnings.join('; ');
            await chrome.storage.local.set({ userScripts: blockedScripts });
        }
        throw new Error(`Code blocked for safety: ${safetyCheck.warnings[0]}`);
    }
    
    // 6. Run Immediately (only if safe)
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
                // Use helper function for safe regex matching
                const regex = createMatchRegex(script.matches);
                return regex && regex.test(details.url);
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
                                // Fix: Wait for document to be ready before injection
                                const inject = () => {
                                    const scriptEl = document.createElement('script');
                                    scriptEl.textContent = code;
                                    // Inject immediately
                                    (document.head || document.documentElement).appendChild(scriptEl);
                                    scriptEl.remove();
                                };
                                
                                if (document.readyState === 'loading') {
                                    document.addEventListener('DOMContentLoaded', inject, { once: true });
                                } else {
                                    inject();
                                }
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

  // 防止无限递归 (扩展到50步)
  const MAX_STEPS = 50;
  if (globalState.actionHistory.length > MAX_STEPS) {
      globalState.stepInfo = "❌ 任务步骤过多，强制停止防止死循环。";
      globalState.active = false;
      saveState();
      chrome.tabs.sendMessage(globalState.tabId, { type: "UPDATE_OVERLAY", text: globalState.stepInfo }).catch(() => {});
      return;
  }
  
  // 历史压缩：当历史超过30条时，压缩旧记录
  if (globalState.actionHistory.length > 30) {
      const oldHistory = globalState.actionHistory.slice(0, -20);
      const recentHistory = globalState.actionHistory.slice(-20);
      const summary = `[Compressed ${oldHistory.length} steps]: ` + 
          oldHistory.map(h => h.thought?.substring(0, 30)).join(' → ');
      globalState.actionHistory = [{ thought: summary, action: { note: 'compressed' } }, ...recentHistory];
      saveState();
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
        "action": { "navigate": "url", "fill": {id:val}, "click": "id", "create_script": {"reason": "why"} },
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
        if (plan.action.create_script) {
            // Check if we need confirmation (Only if explicit AGENT mode)
            if (globalState.initialMode === "AGENT") {
                 updateOverlay("⚠️ Switching to Script Mode... Confirm?");
                 chrome.tabs.sendMessage(globalState.tabId, { type: "SHOW_CONFIRM", text: "AI suggests switching to Script Mode. Allow?" }).catch(()=>{});
                 globalState.waitingForConfirm = true;
                 saveState();
                 return; // Pause Loop
            }
            
            updateOverlay("📜 发现脚本模式更合适，正在切换...");
            globalState.active = false;
            saveState();
            await handleScriptGeneration(globalState.tabId, "URL", globalState.userPrompt, globalState.actionHistory);
            return;
        }

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
  
  // 可见性检查辅助函数
  function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
  }
  
  // 生成稳定选择器
  function buildSelector(el) {
      if (!el) return null;
      // 优先级: data-testid > id > name > aria-label > class组合
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if (testId) return `[data-testid="${testId}"]`;
      if (el.id) return `#${el.id}`;
      if (el.name) return `[name="${el.name}"]`;
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
      // 回退到标签+类名
      let sel = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
          const classes = el.className.split(/\s+/).filter(c => c && !c.includes(':'));
          if (classes.length > 0) sel += '.' + classes.slice(0, 2).join('.');
      }
      return sel;
  }

  const inputEls = document.querySelectorAll('input, textarea, select');
  const inputList = [];
  inputEls.forEach((el) => {
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'image') return;
    if (!isVisible(el)) return;
    
    const selector = buildSelector(el);
    inputList.push({
        key: el.name || el.id || ("idx_" + inputList.length), 
        placeholder: el.placeholder || "",
        label: el.previousElementSibling?.innerText?.substring(0, 30) || "",
        type: el.type || el.tagName.toLowerCase(),
        selector: selector,
        disabled: el.disabled,
        value: el.value?.substring(0, 20) || ""
    });
  });

  const btnList = [];
  const seenElements = new WeakSet();
  
  // 1. 标准按钮 + role="button" + 链接按钮
  const btnSelectors = [
      'button:not([disabled])',
      'input[type="submit"]:not([disabled])',
      'input[type="button"]:not([disabled])',
      '[role="button"]',
      'a[href]',
      '[onclick]'
  ];
  
  btnSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach((el, index) => {
          if (seenElements.has(el)) return;
          if (!isVisible(el)) return;
          
          seenElements.add(el);
          
          let btnText = el.innerText || el.value || el.title || el.getAttribute('aria-label') || "";
          btnText = btnText.substring(0, 30).replace(/\n/g, " ").trim();
          if (btnText.length < 1) return;
          
          const selector = buildSelector(el);
          btnList.push({
              key: el.id || el.name || selector || ("btn_idx_" + btnList.length),
              text: btnText,
              tagName: el.tagName,
              selector: selector,
              type: el.type || el.getAttribute('role') || 'link'
          });
      });
  });

  // 2. 🔍 搜索结果链接 (h1-h3 里的链接)
  document.querySelectorAll('h1 a, h2 a, h3 a').forEach((el, index) => {
      if (seenElements.has(el)) return;
      seenElements.add(el);
      
      let t = el.innerText.substring(0, 50).replace(/\n/g, " ").trim();
      if (t.length > 0 && isVisible(el)) {
          const selector = buildSelector(el);
          btnList.push({ 
              key: "link_res_" + index,
              text: "[搜索结果] " + t,
              isResult: true,
              selector: selector,
              href: el.href?.substring(0, 100)
          });
      }
  });

  return {
    text: bodyText.substring(0, 2500),
    inputs: inputList.slice(0, 30),
    buttons: btnList.slice(0, 50),
    url: window.location.href,
    title: document.title
  };
}

// ==========================================
// ⚡️ 执行者 (加强版：支持复杂选择器)
// ==========================================
function executeActionPlan(action) {
  const result = { success: false, details: {} };
  
  // 辅助函数
  function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
  }
  
  function isInteractable(el) {
      if (!el || !isVisible(el)) return false;
      if (el.disabled) return false;
      const rect = el.getBoundingClientRect();
      // 检查是否在视口内
      if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
      return true;
  }
  
  // 多策略元素查找
  function findElement(key) {
      // 1. 直接作为选择器尝试
      try {
          const el = document.querySelector(key);
          if (el && isVisible(el)) return el;
      } catch(e) {}
      
      // 2. ID 匹配
      let el = document.getElementById(key);
      if (el && isVisible(el)) return el;
      
      // 3. Name 匹配
      el = document.querySelector(`[name="${key}"]`);
      if (el && isVisible(el)) return el;
      
      // 4. data-testid 匹配
      el = document.querySelector(`[data-testid="${key}"]`);
      if (el && isVisible(el)) return el;
      
      // 5. aria-label 匹配
      el = document.querySelector(`[aria-label="${key}"]`);
      if (el && isVisible(el)) return el;
      
      // 6. 文本匹配 (按钮/链接)
      const candidates = document.querySelectorAll('button, a, input[type="submit"], [role="button"]');
      for (const c of candidates) {
          const text = (c.innerText || c.value || '').toLowerCase().trim();
          if (text.includes(key.toLowerCase()) && isVisible(c)) return c;
      }
      
      // 7. 索引匹配 (兼容旧格式)
      if (key.startsWith("idx_")) {
          const idx = parseInt(key.split("_")[1]);
          const all = Array.from(document.querySelectorAll('input, textarea, select')).filter(isVisible);
          if (all[idx]) return all[idx];
      }
      
      if (key.startsWith("btn_idx_")) {
          const idx = parseInt(key.split("_")[2]);
          const all = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]')).filter(isVisible);
          if (all[idx]) return all[idx];
      }
      
      if (key.startsWith("link_res_")) {
          const idx = parseInt(key.split("_")[2]);
          const all = Array.from(document.querySelectorAll('h1 a, h2 a, h3 a')).filter(isVisible);
          if (all[idx]) return all[idx];
      }
      
      return null;
  }
  
  // 填充操作
  if (action.fill) {
    result.details.fill = [];
    for (const [key, value] of Object.entries(action.fill)) {
      const el = findElement(key);
      
      if (el && isInteractable(el)) {
          // 模拟真实输入
          el.focus();
          el.value = '';
          el.value = value;
          
          // 触发完整事件链
          el.dispatchEvent(new Event('focus', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
          
          // 视觉反馈
          el.style.outline = '2px solid #4CAF50';
          el.style.backgroundColor = '#e8f5e9';
          
          result.details.fill.push({ key, success: true });
          result.success = true;
      } else {
          result.details.fill.push({ key, success: false, reason: el ? 'not interactable' : 'not found' });
      }
    }
  }

  // 点击操作
  if (action.click) {
      const btn = findElement(action.click);
      
      if (btn) {
          // 检查可交互性
          if (!isInteractable(btn)) {
              // 尝试滚动到视图
              btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          
          console.log("🖱️ 点击:", btn);
          
          // 视觉高亮
          const originalStyle = btn.style.cssText;
          btn.style.outline = '3px solid #f44336';
          btn.style.backgroundColor = '#ffeb3b';
          btn.style.transition = 'all 0.2s';
          
          // 滚动后等待一下再点击
          setTimeout(() => {
              // 模拟鼠标事件链
              btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
              btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              btn.click();
              
              // 恢复样式
              setTimeout(() => {
                  btn.style.cssText = originalStyle;
              }, 500);
          }, 350);
          
          result.success = true;
          result.details.click = { target: action.click, found: true };
      } else {
          result.details.click = { target: action.click, found: false };
          console.warn("⚠️ 元素未找到:", action.click);
      }
  }
  
  return result;
}

// ==========================================
// AI API Caller (with rate limiting and safety)
// ==========================================
async function callAI(prompt, format = "json_object") {
  const { apiKey, providerUrl, modelName } = await chrome.storage.local.get(["apiKey", "providerUrl", "modelName"]);
  
  if (!apiKey) {
      throw new Error("API Key not configured. Please click the ⚙️ icon to set it up.");
  }
  
  // Rate limiting: ensure minimum interval between calls
  const now = Date.now();
  const elapsed = now - lastApiCallTime;
  if (elapsed < API_MIN_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, API_MIN_INTERVAL_MS - elapsed));
  }
  lastApiCallTime = Date.now();
  
  const API_ENDPOINT = providerUrl || "https://openrouter.ai/api/v1/chat/completions";
  const MODEL_ID = modelName || "google/gemini-2.5-flash";

  const response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": chrome.runtime.getURL("/"),
    },
    body: JSON.stringify({
      model: MODEL_ID,
      response_format: { type: format }, 
      messages: [
        { role: "system", content: "You are an automation assistant. Output pure JSON only." },
        { role: "user", content: prompt }
      ]
    })
  });
  
  const data = await response.json();
  if (data.error) {
      // Sanitize error message to avoid leaking sensitive info
      const safeMessage = data.error.message?.replace(/sk-[a-zA-Z0-9]+/g, '[API_KEY_REDACTED]') || 'Unknown API error';
      throw new Error(safeMessage);
  }
  if (!data.choices || !data.choices[0]) {
      throw new Error('Invalid API response structure');
  }
  return data.choices[0].message.content;
}
