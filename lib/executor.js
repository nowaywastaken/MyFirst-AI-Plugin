// ==========================================
// ⚡️ 确定性执行器 V3 (Stability Aware)
// ==========================================
// 核心改进：引入智能等待 (waitForStability)
// 移除硬编码 delay

const EXECUTOR_CONFIG = {
    maxRetries: 3,
    defaultTimeout: 15000,
    quickDelay: 300,
    stabilityDuration: 500 // 需要由多长时间的“静默”才算稳定
};

/**
 * 智能等待页面稳定
 */
async function waitForStability(tabId, timeout = EXECUTOR_CONFIG.defaultTimeout) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (duration, maxWait) => {
                return new Promise(resolve => {
                    let lastMutation = Date.now();
                    let observer = new MutationObserver(() => {
                        lastMutation = Date.now();
                    });
                    
                    observer.observe(document.body, { 
                        subtree: true, 
                        childList: true, 
                        attributes: true, 
                        characterData: true 
                    });
                    
                    const interval = setInterval(() => {
                        const now = Date.now();
                        // 1. DOM 静默检测
                        const isDomStable = (now - lastMutation) > duration;
                        // 2. ReadyState 检测
                        const isReady = document.readyState === 'complete';
                        
                        if (isDomStable && isReady) {
                            cleanup();
                            resolve({ stable: true });
                        }
                        
                        // 超时
                        if (now - lastMutation > maxWait) { 
                            // 注意：这里的 timeout 逻辑有点怪，通常是总时间超时
                        }
                    }, 100);
                    
                    // 总超时强制结束
                    const timeoutId = setTimeout(() => {
                        cleanup();
                        resolve({ stable: false, reason: 'timeout' });
                    }, maxWait);
                    
                    function cleanup() {
                        observer.disconnect();
                        clearInterval(interval);
                        clearTimeout(timeoutId);
                    }
                });
            },
            args: [EXECUTOR_CONFIG.stabilityDuration, timeout]
        });
    } catch (e) {
        // Tab 可能关闭了
        console.warn('Wait stability failed:', e);
    }
}



/**
 * 验证输入值是否正确设置
 */
async function verifyValue(tabId, selector, expectedValue) {
    try {
        const result = await chrome.scripting.executeScript({
            target: { tabId },
            func: (sel, val) => {
                const el = document.querySelector(sel);
                if (!el) return { success: false, reason: 'not found' };
                // 简单的包含匹配，防止格式化差异
                const current = el.value || '';
                return { success: current.includes(val) || val.includes(current), current }; 
            },
            args: [selector, expectedValue]
        });
        return result[0]?.result || { success: false };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * 执行单个步骤
 */
async function executeStep(step, context = {}) {
    const { tabId, userMemory = {}, onProgress } = context;
    
    // 替换占位符 (委托给 Planner 或自己做)
    const resolvedStep = self.Planner?.resolveStepPlaceholders 
        ? self.Planner.resolveStepPlaceholders(step, userMemory)
        : step;
    
    const result = {
        stepId: step.id,
        action: step.action,
        success: false,
        error: null,
        executedAt: Date.now()
    };
    
    // 报告进度
    if (onProgress) onProgress({ type: 'step_start', step: resolvedStep });
    
    try {
        switch (resolvedStep.action) {
            case 'navigate':
                await executeNavigate(tabId, resolvedStep);
                result.success = true;
                break;
                
            case 'fill':
                await executeFill(tabId, resolvedStep);
                result.success = true;
                break;
                
            case 'click':
                await executeClick(tabId, resolvedStep, result);
                break;
                
            case 'wait': // 显式等待
                await delay(parseInt(resolvedStep.value) || 1000);
                result.success = true;
                break;
                
            case 'scroll':
                await executeScroll(tabId, resolvedStep);
                result.success = true;
                break;
                
            case 'select':
                await executeSelect(tabId, resolvedStep);
                result.success = true;
                break;

            default:
                throw new Error(`Unknown action: ${resolvedStep.action}`);
        }
        
        // 🌟 动作后自动等待稳定 (核心改进)
        if (['click', 'navigate', 'fill', 'select'].includes(resolvedStep.action)) {
            // 对 fill 操作进行值验证
            if (resolvedStep.action === 'fill') {
                const verifyRes = await verifyValue(tabId, resolvedStep.target, resolvedStep.value);
                if (!verifyRes.success) {
                    console.warn(`Verify failed for ${resolvedStep.target}, retrying once...`);
                    // Retry once
                    await executeFill(tabId, resolvedStep);
                }
            }
            
            await waitForStability(tabId, 2000); 
        }

    } catch (error) {
        result.error = error.message;
        result.success = false;
        console.error(`Step failed:`, error);
    }
    
    // 报告结果
    if (onProgress) onProgress({ type: 'step_complete', step: resolvedStep, result });
    
    return result;
}

// ... 具体实现 ...

async function executeNavigate(tabId, step) {
    await chrome.tabs.update(tabId, { url: step.target });
    // 等待加载完成
    await new Promise(resolve => {
        const listener = (tid, info) => {
            if (tid === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener); // 超时也继续
            resolve(); 
        }, 15000);
    });
}

async function executeFill(tabId, step) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector, value) => {
            const el = document.querySelector(selector);
            if (!el) throw new Error('Element not found: ' + selector);
            
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        args: [step.target, step.value]
    });
}

async function executeClick(tabId, step, result) {
    const execResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => {
            const el = document.querySelector(selector);
            if (!el) throw new Error('Element not found: ' + selector);
            
            // 滚动
            el.scrollIntoView({ behavior: 'auto', block: 'center' });
            
            // 模拟完整点击
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            el.click();
            
            return { isLink: el.tagName === 'A' };
        },
        args: [step.target]
    });
    
    result.success = true;
    result.causedNavigation = execResult[0]?.result?.isLink;
}

async function executeScroll(tabId, step) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (target) => {
            if (target && target !== 'window') {
                const el = document.querySelector(target);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                window.scrollBy(0, 500);
            }
        },
        args: [step.target]
    });
    await delay(300); // 滚动动画
}

async function executeSelect(tabId, step) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector, value) => {
            const el = document.querySelector(selector);
            if (!el) throw new Error('Element not found');
            el.value = value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        args: [step.target, step.value]
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 导出
if (typeof self !== 'undefined') {
    self.Executor = {
        executeStep,
        waitForStability,
        EXECUTOR_CONFIG
    };
}
