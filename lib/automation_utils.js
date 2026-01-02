// ==========================================
// 🛠️ 自动化可靠性工具集 (Automation Utilities)
// ==========================================
// 提供智能等待、状态捕获、DOM 监控等高级自动化功能

/**
 * 智能等待直到条件满足
 * @param {Function} condition - 返回 true/false 的检查函数
 * @param {Object} options - 配置选项
 * @returns {Promise<boolean>} - 条件是否在超时前满足
 */
function waitUntil(condition, options = {}) {
    const { timeout = 10000, interval = 100, signal } = options;
    
    return new Promise((resolve) => {
        const startTime = Date.now();
        
        const check = () => {
            // 支持 AbortSignal 取消
            if (signal?.aborted) {
                resolve(false);
                return;
            }
            
            try {
                if (condition()) {
                    resolve(true);
                    return;
                }
            } catch (e) {
                // 条件检查出错，继续等待
            }
            
            if (Date.now() - startTime >= timeout) {
                resolve(false);
                return;
            }
            
            setTimeout(check, interval);
        };
        
        check();
    });
}

/**
 * 等待元素出现在 DOM 中
 * @param {string} selector - CSS 选择器
 * @param {Object} options - 配置选项
 * @returns {Promise<Element|null>}
 */
async function waitForElement(selector, options = {}) {
    const { timeout = 10000, root = document, visible = false } = options;
    
    // 快速路径：元素已存在
    let el = root.querySelector(selector);
    if (el && (!visible || isVisible(el))) return el;
    
    // 使用 MutationObserver 高效等待
    return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            const el = root.querySelector(selector);
            if (el && (!visible || isVisible(el))) {
                observer.disconnect();
                resolve(el);
            }
        });
        
        observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: visible // 如果需要可见性检查，也监听属性变化
        });
        
        // 超时处理
        setTimeout(() => {
            observer.disconnect();
            resolve(root.querySelector(selector)); // 最后再试一次
        }, timeout);
    });
}

/**
 * 等待页面稳定（无 DOM 变化）
 * @param {Object} options - 配置选项
 * @returns {Promise<void>}
 */
function waitForDOMStable(options = {}) {
    const { timeout = 5000, debounce = 300 } = options;
    
    return new Promise((resolve) => {
        let lastMutationTime = Date.now();
        let resolved = false;
        
        const observer = new MutationObserver(() => {
            lastMutationTime = Date.now();
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
        });
        
        const checkStable = () => {
            if (resolved) return;
            
            const timeSinceLastMutation = Date.now() - lastMutationTime;
            
            if (timeSinceLastMutation >= debounce) {
                observer.disconnect();
                resolved = true;
                resolve();
            } else if (Date.now() - lastMutationTime + debounce < timeout) {
                setTimeout(checkStable, debounce - timeSinceLastMutation + 10);
            }
        };
        
        // 超时保护
        setTimeout(() => {
            if (!resolved) {
                observer.disconnect();
                resolved = true;
                resolve();
            }
        }, timeout);
        
        // 首次检查
        setTimeout(checkStable, debounce);
    });
}

/**
 * 检查元素是否可见
 * @param {Element} el 
 * @returns {boolean}
 */
function isVisible(el) {
    if (!el) return false;
    
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }
    
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

/**
 * 检查元素是否可交互
 * @param {Element} el 
 * @returns {Object} - { interactable: boolean, reasons: string[] }
 */
function isElementInteractable(el) {
    const reasons = [];
    
    if (!el) {
        return { interactable: false, reasons: ['Element is null'] };
    }
    
    // 1. 可见性检查
    if (!isVisible(el)) {
        reasons.push('Element is not visible');
    }
    
    // 2. 禁用状态
    if (el.disabled) {
        reasons.push('Element is disabled');
    }
    
    // 3. 只读状态（针对输入框）
    if (el.readOnly && ['INPUT', 'TEXTAREA'].includes(el.tagName)) {
        reasons.push('Element is read-only');
    }
    
    // 4. 是否被其他元素遮挡
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const topElement = document.elementFromPoint(centerX, centerY);
    
    if (topElement && topElement !== el && !el.contains(topElement)) {
        // 检查是否真的被遮挡（可能是伪元素或透明层）
        const topStyle = window.getComputedStyle(topElement);
        if (topStyle.pointerEvents !== 'none') {
            reasons.push(`Element is covered by: ${topElement.tagName}${topElement.id ? '#' + topElement.id : ''}`);
        }
    }
    
    // 5. 不在视口内
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    if (rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) {
        reasons.push('Element is outside viewport');
    }
    
    return {
        interactable: reasons.length === 0,
        reasons
    };
}

/**
 * 捕获元素状态快照（用于操作前后对比）
 * @param {Element|string} elOrSelector 
 * @returns {Object|null}
 */
function captureElementState(elOrSelector) {
    const el = typeof elOrSelector === 'string' 
        ? document.querySelector(elOrSelector) 
        : elOrSelector;
    
    if (!el) return null;
    
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    
    return {
        tagName: el.tagName,
        id: el.id,
        className: el.className,
        innerText: el.innerText?.substring(0, 100),
        value: el.value,
        checked: el.checked,
        disabled: el.disabled,
        href: el.href,
        rect: { 
            top: rect.top, 
            left: rect.left, 
            width: rect.width, 
            height: rect.height 
        },
        display: style.display,
        visibility: style.visibility,
        children: el.children.length,
        timestamp: Date.now()
    };
}

/**
 * 对比两个元素状态
 * @param {Object} before 
 * @param {Object} after 
 * @returns {Object} - { changed: boolean, changes: string[] }
 */
function compareElementStates(before, after) {
    if (!before || !after) {
        return { changed: true, changes: ['Element state unavailable'] };
    }
    
    const changes = [];
    const keysToCompare = ['innerText', 'value', 'checked', 'disabled', 'display', 'visibility', 'children'];
    
    for (const key of keysToCompare) {
        if (before[key] !== after[key]) {
            changes.push(`${key}: "${before[key]}" → "${after[key]}"`);
        }
    }
    
    // 位置变化检测（可能是动画或滚动）
    if (Math.abs(before.rect.top - after.rect.top) > 5 || 
        Math.abs(before.rect.left - after.rect.left) > 5) {
        changes.push('Position changed');
    }
    
    return {
        changed: changes.length > 0,
        changes
    };
}

/**
 * 滚动元素到视口中心
 * @param {Element|string} elOrSelector 
 * @param {Object} options
 * @returns {Promise<boolean>}
 */
async function scrollIntoViewSafe(elOrSelector, options = {}) {
    const el = typeof elOrSelector === 'string' 
        ? document.querySelector(elOrSelector) 
        : elOrSelector;
    
    if (!el) return false;
    
    const { behavior = 'smooth', block = 'center', timeout = 1000 } = options;
    
    el.scrollIntoView({ behavior, block, inline: 'center' });
    
    // 等待滚动完成
    return new Promise(resolve => {
        const startTime = Date.now();
        let lastTop = el.getBoundingClientRect().top;
        
        const checkScrollComplete = () => {
            const currentTop = el.getBoundingClientRect().top;
            
            if (Math.abs(currentTop - lastTop) < 1 || Date.now() - startTime > timeout) {
                resolve(true);
            } else {
                lastTop = currentTop;
                requestAnimationFrame(checkScrollComplete);
            }
        };
        
        requestAnimationFrame(checkScrollComplete);
    });
}

/**
 * 模拟真实用户输入
 * @param {Element} el 
 * @param {string} text 
 * @param {Object} options
 */
async function simulateTyping(el, text, options = {}) {
    const { clearFirst = true, delay = 0 } = options;
    
    if (!el) return false;
    
    // 聚焦
    el.focus();
    
    // 清空
    if (clearFirst) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    if (delay === 0) {
        // 快速模式
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        // 模拟逐字输入
        for (const char of text) {
            el.value += char;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
            
            if (delay > 0) {
                await new Promise(r => setTimeout(r, delay));
            }
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    return true;
}

/**
 * 安全点击元素（含交互性检查和重试）
 * @param {Element|string} elOrSelector 
 * @param {Object} options
 * @returns {Promise<Object>} - { success: boolean, message: string }
 */
async function safeClick(elOrSelector, options = {}) {
    const { maxRetries = 3, scrollIfNeeded = true } = options;
    
    let el = typeof elOrSelector === 'string' 
        ? document.querySelector(elOrSelector) 
        : elOrSelector;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (!el) {
            // 重新查找
            if (typeof elOrSelector === 'string') {
                await waitForElement(elOrSelector, { timeout: 2000 });
                el = document.querySelector(elOrSelector);
            }
            if (!el) continue;
        }
        
        const interactable = isElementInteractable(el);
        
        if (!interactable.interactable) {
            // 尝试修复常见问题
            if (interactable.reasons.includes('Element is outside viewport') && scrollIfNeeded) {
                await scrollIntoViewSafe(el);
                continue; // 重新检查
            }
            
            if (attempt === maxRetries - 1) {
                return { 
                    success: false, 
                    message: `Element not interactable: ${interactable.reasons.join(', ')}` 
                };
            }
            
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        
        // 执行点击
        const beforeState = captureElementState(el);
        el.click();
        
        return { success: true, beforeState, message: 'Click executed' };
    }
    
    return { success: false, message: 'Max retries exceeded' };
}

// 挂载到 Window
window.automation = {
    waitUntil,
    waitForElement,
    waitForDOMStable,
    isVisible,
    isElementInteractable,
    captureElementState,
    compareElementStates,
    scrollIntoViewSafe,
    simulateTyping,
    safeClick
};
