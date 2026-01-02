// ==========================================
// 🧠 AI 规划器 V3 -Snapshot & GoalStack
// ==========================================
// 核心改进：基于 Accessibility Tree 的认知模型
// 引入 Goal Stack 保持长期意图

const PLANNER_CONFIG = {
    maxIterations: 30,
    maxTokensPerCall: 2000,
    temperature: 0.2
};

// 当前正在处理的 tabId（用于发送思考消息）
let currentTargetTabId = null;

/**
 * 构建迭代规划 Prompt (V5 Session Aware)
 */
function buildIterativePlannerPrompt(userGoal, domTree, actionHistory = [], memory = {}, goalStack = [], milestones = []) {
    const historyText = actionHistory.length > 0 
        ? actionHistory.map((h, i) => {
            let line = `step ${i + 1}: ${h.description} -> ${h.success ? '✅OK' : '❌Fail'}`;
            if (h.stateChange) line += ` [${h.stateChange}]`;
            if (h.action === 'SYSTEM_LOOP_DETECTED') line = `step ${i + 1}: ⚠️ SYSTEM: Loop detected. Try a different approach.`;
            return line;
        }).join('\n')
        : '(No actions yet)';

    const currentGoal = goalStack.length > 0 ? goalStack[goalStack.length - 1] : userGoal;
    const goalContext = goalStack.length > 0 
        ? `Goal Stack:\n${goalStack.map((g,i) => `${i+1}. ${g}`).join('\n')}\nCurrent Focus: "${currentGoal}"`
        : `Main Goal: "${userGoal}"`;
    
    // 🎯 V5: Milestones
    const milestonesText = milestones.length > 0
        ? milestones.map(m => `✅ ${m.label} (step ${m.stepIdx})`).join('\n')
        : '(No milestones yet)';

    return `# Browser Automation Agent (V5 Session Aware)

## User Goal
"${userGoal}"

## Completed Milestones
${milestonesText}

## Cognitive State
${goalContext}

## Page Snapshot (Accessibility Tree)
Pseudo-HTML representation of the current page structure.
Interactive elements have 'ai-id'. USE THIS ID FOR ACTIONS.
<snapshot>
${domTree}
</snapshot>

## Action History
${historyText}

## ⚠️ Critical Rules
1. **If you see [PAGE_SAME]**: Your action did NOT change the page. Try a different target or approach.
2. **If you see SYSTEM_LOOP_DETECTED**: You are in a loop. You MUST choose a completely different strategy.
3. **If you see [PAGE_CHANGED]**: Your action worked. Proceed with the next step.

## Instructions
1. **Analyze**: Understand the page structure and your current goal.
2. **Goal Management**: 
   - If the current sub-goal is finished, pop it.
   - If the main goal requires multiple steps, push new sub-goals.
3. **Decide Action**: Choose the SINGLE next logical step.
   - Use 'ai-id' from the snapshot as target.
   - If extracting text, target the element containing it.
   - If waiting is needed (e.g. after click), use "wait".

## 🎯 Semantic Matching Guide (CRITICAL)
When filling forms or selecting inputs:
1. **READ the 'visual_label' attribute** - This shows what text/label is associated with each input field.
2. **MATCH keywords** from the user's goal to the 'visual_label'. Example:
   - User says: "Enter the secret code ALPHA-7"
   - You must find an input with visual_label containing "secret code" - NOT the first input.
3. **If 'visual_hint="highlighted-blue"'** - This indicates a visually highlighted/important field.
4. **NEVER blindly pick the first input** - Always verify the label matches the user's intent.
5. **Use 'placeholder' attribute** as secondary hint if no visual_label matches.

## 🛑 VERIFICATION REQUIRED 🛑
- **NEVER** mark \`goalCompleted: true\` immediately after a clicking an action button (Submit, Search, etc.).
- You **MUST** wait to see the RESULT of the action (e.g., success message, new page content) in the next step.
- If you just clicked "Submit", your next action should be \`wait\` or inspecting the new page, NOT finishing.
- \`goalCompleted\` means the USER'S INTENT is fully satisfied and verified.

## Output Format (JSON ONLY)
{
  "thinking": "Brief analysis of current state -> reason for next action",
  "updatedGoalStack": ["Main Goal", "Sub Goal 1", ...], 
  "goalCompleted": boolean,
  "nextAction": {
    "action": "click" | "fill" | "navigate" | "scroll" | "wait" | "select" | null,
    "target": "ai-id",
    "value": "text to fill / option value",
    "description": "Short description for UI"
  },
  "confidence": 0.0-1.0
}
Note: 
- 'updatedGoalStack' should be the NEW state of the stack.
- If 'goalCompleted' is true, 'nextAction' should be null.
`;
}

/**
 * 调用 AI 进行迭代规划 (流式模式)
 */
async function callIterativePlannerAI(prompt, screenshot, config) {
    const { apiKey, providerUrl, modelName } = config;
    
    if (!apiKey) throw new Error('API Key 未配置');
    
    const endpoint = providerUrl || 'https://openrouter.ai/api/v1/chat/completions';
    
    const messages = [
        { role: 'system', content: 'You are a precise browser automation agent. Analyze the Accessibility Tree and move step-by-step.' }
    ];
    
    if (screenshot) {
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: screenshot, detail: 'low' } }
            ]
        });
    } else {
        messages.push({ role: 'user', content: prompt });
    }
    
    // ... (Use same fetch logic as before, just cleaner) ...
    // Reuse the fetch logic from previous version or rewrite simply
    
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName || 'google/gemini-2.0-flash-001',
                messages,
                stream: true,
                max_tokens: PLANNER_CONFIG.maxTokensPerCall,
                temperature: PLANNER_CONFIG.temperature,
                response_format: { type: "json_object" } // Force JSON if supported
            })
        });

        if (!response.ok) {
             // Error handling logic...
             const errData = await response.json().catch(() => ({}));
             throw new Error(errData.error?.message || `HTTP ${response.status}`);
        }
    } catch (e) {
        // Simple retry logic could go here
        throw e;
    }

    // Stream reading logic (Copied from V2)
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    
    broadcastThinkingUpdate('');
    
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (value) buffer += decoder.decode(value, { stream: true });
            
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                if (!data) continue;
                try {
                    const json = JSON.parse(data);
                    const content = json.choices?.[0]?.delta?.content || '';
                    if (content) {
                        fullContent += content;
                        broadcastThinkingUpdate(content);
                    }
                } catch (e) {}
            }
            if (done) break;
        }
    } finally {
        reader.releaseLock();
    }
    
    broadcastThinkingDone();
    return fullContent;
}

/**
 * 广播思考状态 (保持不变)
 */
function broadcastThinkingUpdate(content) {
    if (!currentTargetTabId) return;
    chrome.tabs.sendMessage(currentTargetTabId, { type: 'AI_THINKING_UPDATE', content }).catch(() => {});
}

function broadcastThinkingDone() {
    if (!currentTargetTabId) return;
    chrome.tabs.sendMessage(currentTargetTabId, { type: 'AI_THINKING_DONE' }).catch(() => {});
}

/**
 * 解析响应 (V3)
 */
function parseIterativeResponse(response) {
    let jsonStr = response;
    // Extract JSON block
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1];
    
    // Find first { ... }
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    try {
        const result = JSON.parse(jsonStr);
        return {
            thinking: result.thinking || '',
            goalCompleted: result.goalCompleted === true,
            updatedGoalStack: result.updatedGoalStack || [],
            nextAction: result.nextAction || null,
            confidence: result.confidence || 0.5
        };
    } catch (e) {
        console.error('JSON Parse Error:', e);
        // Fallback
        return {
            thinking: "Error parsing AI response",
            goalCompleted: false,
            updatedGoalStack: [],
            nextAction: null,
            confidence: 0
        };
    }
}

/**
 * 迭代规划主函数 - 规划下一步
 */
async function planNextStep(options) {
    const { userGoal, pageData, screenshot, actionHistory, memory, apiConfig, tabId, goalStack, previousPageHash } = options;
    
    currentTargetTabId = tabId || null;
    
    // 使用 domTree 而不是 summary
    const domTree = pageData.domTree || "No DOM data available";
    const currentHash = pageData.contentHash;
    
    // 构建 prompt
    const prompt = buildIterativePlannerPrompt(userGoal, domTree, actionHistory, memory, goalStack);
    
    // 调用 AI
    console.log(`🧠 V3 Planning (Goal: ${goalStack[goalStack.length-1] || userGoal})...`);
    const aiResponse = await callIterativePlannerAI(prompt, screenshot, apiConfig);
    
    // 解析
    const result = parseIterativeResponse(aiResponse);
    
    // 🛡️ System Supervisor: Completion Guard
    // 如果 AI 认为任务完成了，但页面状态没有变化（且上一步是动作），则强制驳回
    if (result.goalCompleted && actionHistory.length > 0) {
        const lastAction = actionHistory[actionHistory.length - 1];
        
        // 如果上一步是交互动作 (action that should change state)
        if (['click', 'navigate', 'fill', 'submit'].includes(lastAction.action)) {
            // 简单的哈希对比
            if (currentHash && previousPageHash && currentHash === previousPageHash) {
                console.warn('🛡️ Completion Guard Triggered: Page state unchanged. Forcing WAIT.');
                
                return {
                    goalCompleted: false, // Override
                    updatedGoalStack: goalStack, // Keep visible
                    thinking: `[System] AI planned completion, but page state is identical to previous step. Forcing wait to verify action effect.`,
                    nextStep: {
                        id: actionHistory.length + 1,
                        action: 'wait',
                        target: null,
                        value: '2000',
                        description: 'System: Waiting for page update...'
                    },
                    confidence: 0.9
                };
            }
        }
    }
    
    return {
        goalCompleted: result.goalCompleted,
        updatedGoalStack: result.updatedGoalStack,
        thinking: result.thinking,
        nextStep: result.nextAction ? {
            id: actionHistory.length + 1,
            action: result.nextAction.action,
            target: result.nextAction.target, // This will be 'ai-id'
            value: result.nextAction.value,
            description: result.nextAction.description
        } : null,
        confidence: result.confidence
    };
}

/**
 * 占位符替换 (保持不变)
 */
function resolveStepPlaceholders(step, userMemory) {
    const resolved = { ...step };
    if (resolved.value && typeof resolved.value === 'string') {
        resolved.value = resolved.value.replace(/\{\{memory\.(\w+)\}\}/g, (m, k) => userMemory[k] || m);
    }
    return resolved;
}

// 导出
if (typeof self !== 'undefined') {
    self.Planner = {
        planNextStep,
        resolveStepPlaceholders,
        PLANNER_CONFIG
    };
}
