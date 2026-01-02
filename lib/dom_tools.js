// ==========================================
// 🕵️‍♂️ DOM 侦探工具集 V2 (增强版)
// ==========================================
// 支持多策略选择、Shadow DOM、智能等待、可交互性检查

// ==========================================
// 🔍 多策略元素选择系统
// ==========================================

/**
 * 选择策略优先级（越靠前优先级越高）
 */
const SELECTION_STRATEGIES = [
    {
        name: 'testId',
        find: (query) => document.querySelector(`[data-testid="${query}"], [data-test="${query}"], [data-cy="${query}"]`),
        buildSelector: (el) => {
            const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy');
            if (testId) return `[data-testid="${testId}"]`;
            return null;
        }
    },
    {
        name: 'id',
        find: (query) => document.getElementById(query),
        buildSelector: (el) => el.id ? `#${el.id}` : null
    },
    {
        name: 'role',
        find: (query) => document.querySelector(`[role="${query}"]`),
        buildSelector: (el) => {
            const role = el.getAttribute('role');
            if (role) return `[role="${role}"]`;
            return null;
        }
    },
    {
        name: 'ariaLabel',
        find: (query) => document.querySelector(`[aria-label*="${query}" i]`),
        buildSelector: (el) => {
            const label = el.getAttribute('aria-label');
            if (label) return `[aria-label="${label}"]`;
            return null;
        }
    },
    {
        name: 'name',
        find: (query) => document.querySelector(`[name="${query}"]`),
        buildSelector: (el) => el.name ? `[name="${el.name}"]` : null
    },
    {
        name: 'placeholder',
        find: (query) => document.querySelector(`[placeholder*="${query}" i]`),
        buildSelector: (el) => {
            const ph = el.getAttribute('placeholder');
            if (ph) return `[placeholder="${ph}"]`;
            return null;
        }
    },
    {
        name: 'text',
        find: (query) => {
            // XPath 文本搜索
            const lowerQuery = query.toLowerCase();
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode: (node) => {
                        if (node.textContent.toLowerCase().includes(lowerQuery)) {
                            return NodeFilter.FILTER_ACCEPT;
                        }
                        return NodeFilter.FILTER_REJECT;
                    }
                }
            );
            const textNode = walker.nextNode();
            return textNode?.parentElement;
        },
        buildSelector: null // 文本匹配不生成选择器
    },
    {
        name: 'css',
        find: (query) => {
            try { return document.querySelector(query); } 
            catch { return null; }
        },
        buildSelector: null
    }
];

/**
 * 智能元素选择 - 尝试多种策略找到元素
 * @param {string} query - 搜索关键词或选择器
 * @param {Object} options - 配置选项
 * @returns {Object} - { element, strategy, selector, confidence }
 */
function tool_smart_select(query, options = {}) {
    if (!query) return { error: "Query is empty" };
    
    const { strategies = SELECTION_STRATEGIES, root = document } = options;
    
    for (const strategy of strategies) {
        try {
            const el = strategy.find(query);
            if (el && isElementVisible(el)) {
                // 尝试生成最佳选择器
                const selector = generateBestSelector(el);
                
                return {
                    tool: "smart_select",
                    found: true,
                    strategy: strategy.name,
                    tagName: el.tagName,
                    id: el.id,
                    text: el.innerText?.substring(0, 50),
                    selector: selector,
                    confidence: calculateSelectorConfidence(selector),
                    interactable: checkInteractable(el)
                };
            }
        } catch (e) {
            // 该策略失败，继续下一个
        }
    }
    
    return { 
        tool: "smart_select",
        found: false, 
        query,
        triedStrategies: strategies.map(s => s.name)
    };
}

/**
 * 生成最稳定的选择器
 * @param {Element} el 
 * @returns {string}
 */
function generateBestSelector(el) {
    if (!el) return null;
    
    // 优先级顺序尝试生成选择器
    for (const strategy of SELECTION_STRATEGIES) {
        if (strategy.buildSelector) {
            const sel = strategy.buildSelector(el);
            if (sel && document.querySelectorAll(sel).length === 1) {
                return sel;
            }
        }
    }
    
    // 回退：组合选择器
    let selector = el.tagName.toLowerCase();
    
    if (el.id) {
        return `#${el.id}`;
    }
    
    if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(/\s+/).filter(c => c && !c.includes(':'));
        if (classes.length > 0) {
            selector += '.' + classes.slice(0, 2).join('.');
        }
    }
    
    // 添加 nth-child 如果仍不唯一
    const parent = el.parentElement;
    if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        if (siblings.length > 1) {
            const idx = siblings.indexOf(el) + 1;
            selector += `:nth-of-type(${idx})`;
        }
    }
    
    return selector;
}

/**
 * 计算选择器可靠性评分 (0-100)
 * @param {string} selector 
 * @returns {number}
 */
function calculateSelectorConfidence(selector) {
    if (!selector) return 0;
    
    let score = 50;
    
    // data-testid 最稳定
    if (selector.includes('data-testid') || selector.includes('data-test')) {
        score += 40;
    }
    // ID 很稳定
    else if (selector.startsWith('#')) {
        score += 35;
    }
    // aria-label 语义化好
    else if (selector.includes('aria-label')) {
        score += 30;
    }
    // role 属性
    else if (selector.includes('role=')) {
        score += 25;
    }
    // name 属性
    else if (selector.includes('name=')) {
        score += 20;
    }
    // 纯类名可能不稳定
    else if (selector.includes('.')) {
        score += 10;
    }
    
    // nth-child 降低可靠性
    if (selector.includes(':nth')) {
        score -= 15;
    }
    
    return Math.min(100, Math.max(0, score));
}

// ==========================================
// 🔎 增强版文本搜索 (Shadow DOM + iframe)
// ==========================================

/**
 * 在页面中搜索包含特定文本的元素 (增强版)
 * @param {string} query - 搜索关键词
 * @param {Object} options - 配置选项
 * @returns {Object} - 搜索结果
 */
function tool_search_text(query, options = {}) {
    if (!query) return { error: "Query is empty" };
    
    const { maxResults = 15, includeHidden = false, scoreThreshold = 0 } = options;
    const results = [];
    const lowerQuery = query.toLowerCase();
    const seenElements = new WeakSet();

    /**
     * 递归遍历节点
     * @param {Node} root 
     * @param {number} depth - 遍历深度
     * @param {boolean} inShadow - 是否在 Shadow DOM 中
     */
    function walk(root, depth = 0, inShadow = false) {
        if (results.length >= maxResults || depth > 20) return;
        if (!root) return;

        if (root.nodeType === Node.ELEMENT_NODE) {
            const el = root;
            
            // 防止重复处理
            if (seenElements.has(el)) return;
            seenElements.add(el);
            
            // 跳过脚本和样式
            if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) return;
            
            // 可见性检查
            if (!includeHidden && !isElementVisible(el)) return;

            // 多维度匹配
            const matchResult = matchElement(el, lowerQuery);
            
            if (matchResult.matched) {
                const selector = generateBestSelector(el);
                const confidence = calculateSelectorConfidence(selector);
                
                if (confidence >= scoreThreshold) {
                    results.push({
                        tagName: el.tagName,
                        id: el.id,
                        className: typeof el.className === 'string' ? el.className : "[SVG/Complex]",
                        text: matchResult.text.substring(0, 80),
                        matchType: matchResult.type,
                        selector: selector,
                        confidence: confidence,
                        inShadow: inShadow,
                        depth: depth,
                        interactable: checkInteractable(el)
                    });
                }
            }
            
            // 遍历 Shadow Root
            if (el.shadowRoot) {
                walk(el.shadowRoot, depth + 1, true);
            }
        }

        // 遍历子节点
        if (root.childNodes) {
            for (const child of root.childNodes) {
                walk(child, depth, inShadow);
            }
        }
    }

    walk(document.body);
    
    // 按可靠性评分排序
    results.sort((a, b) => b.confidence - a.confidence);
    
    return {
        tool: "search",
        query: query,
        location: window.location.href,
        count: results.length,
        results: results
    };
}

/**
 * 多维度匹配元素
 * @param {Element} el 
 * @param {string} lowerQuery 
 * @returns {Object}
 */
function matchElement(el, lowerQuery) {
    // 1. 直接文本节点
    for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            const txt = node.textContent.trim();
            if (txt.toLowerCase().includes(lowerQuery)) {
                return { matched: true, type: 'text', text: txt };
            }
        }
    }
    
    // 2. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.toLowerCase().includes(lowerQuery)) {
        return { matched: true, type: 'aria-label', text: ariaLabel };
    }
    
    // 3. placeholder
    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.toLowerCase().includes(lowerQuery)) {
        return { matched: true, type: 'placeholder', text: placeholder };
    }
    
    // 4. alt 文本 (图片)
    if (el.tagName === 'IMG') {
        const alt = el.alt || '';
        if (alt.toLowerCase().includes(lowerQuery)) {
            return { matched: true, type: 'alt', text: `[IMG: ${alt}]` };
        }
    }
    
    // 5. title 属性
    const title = el.getAttribute('title');
    if (title?.toLowerCase().includes(lowerQuery)) {
        return { matched: true, type: 'title', text: title };
    }
    
    // 6. value (按钮/输入)
    if (el.value?.toLowerCase().includes(lowerQuery)) {
        return { matched: true, type: 'value', text: el.value };
    }
    
    return { matched: false };
}

// ==========================================
// 🔬 检查器增强版
// ==========================================

/**
 * 检查特定 Selector 的详细结构 (增强版)
 * @param {string} selector 
 * @param {Object} options
 */
function tool_inspect_selector(selector, options = {}) {
    if (!selector) return { error: "Selector is empty" };
    
    let el;
    try {
        el = document.querySelector(selector);
    } catch(e) {
        return { error: "Invalid selector: " + e.message };
    }
    
    if (!el) return { error: "Element not found" };
    
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    
    // 获取父级链
    const parents = [];
    let curr = el.parentElement;
    for (let i = 0; i < 3 && curr; i++) {
        parents.push({
            tagName: curr.tagName,
            id: curr.id,
            className: typeof curr.className === 'string' ? curr.className.substring(0, 50) : ''
        });
        curr = curr.parentElement;
    }
    
    // 获取子元素概览
    const children = Array.from(el.children).slice(0, 5).map(c => ({
        tagName: c.tagName,
        id: c.id,
        text: c.innerText?.substring(0, 30)
    }));
    
    return {
        tool: "inspect",
        found: true,
        tagName: el.tagName,
        id: el.id,
        className: typeof el.className === 'string' ? el.className : "[SVG/Complex]",
        text: el.innerText?.substring(0, 100),
        value: el.value,
        href: el.href,
        innerHTML_snippet: el.innerHTML.substring(0, 200).replace(/\n/g, ""),
        rect: { 
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width), 
            height: Math.round(rect.height) 
        },
        styles: {
            display: style.display,
            visibility: style.visibility, 
            position: style.position,
            zIndex: style.zIndex,
            opacity: style.opacity
        },
        attributes: getRelevantAttributes(el),
        interactable: checkInteractable(el),
        parents: parents,
        children: children,
        bestSelector: generateBestSelector(el),
        selectorConfidence: calculateSelectorConfidence(generateBestSelector(el))
    };
}

/**
 * 获取元素的关键属性
 * @param {Element} el 
 */
function getRelevantAttributes(el) {
    const relevant = ['data-testid', 'data-test', 'data-cy', 'role', 'aria-label', 
                      'aria-describedby', 'name', 'type', 'disabled', 'readonly'];
    const attrs = {};
    
    for (const attr of relevant) {
        const val = el.getAttribute(attr);
        if (val !== null) {
            attrs[attr] = val;
        }
    }
    
    return attrs;
}

// ==========================================
// 🎯 交互性检查
// ==========================================

/**
 * 检查元素是否可见
 * @param {Element} el 
 */
function isElementVisible(el) {
    if (!el) return false;
    
    try {
        const style = window.getComputedStyle(el);
        
        if (style.display === 'none' || 
            style.visibility === 'hidden' || 
            style.opacity === '0') {
            return false;
        }
        
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    } catch {
        return false;
    }
}

/**
 * 检查元素是否可交互
 * @param {Element} el 
 * @returns {Object}
 */
function checkInteractable(el) {
    if (!el) return { ok: false, issues: ['null element'] };
    
    const issues = [];
    
    // 可见性
    if (!isElementVisible(el)) {
        issues.push('not visible');
    }
    
    // 禁用状态
    if (el.disabled) {
        issues.push('disabled');
    }
    
    // 只读
    if (el.readOnly) {
        issues.push('readonly');
    }
    
    // 在视口外
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight ||
        rect.right < 0 || rect.left > window.innerWidth) {
        issues.push('outside viewport');
    }
    
    // 被遮挡检查
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    if (centerX >= 0 && centerY >= 0 && 
        centerX <= window.innerWidth && centerY <= window.innerHeight) {
        const topEl = document.elementFromPoint(centerX, centerY);
        if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
            const topStyle = window.getComputedStyle(topEl);
            if (topStyle.pointerEvents !== 'none') {
                issues.push(`covered by ${topEl.tagName}${topEl.id ? '#' + topEl.id : ''}`);
            }
        }
    }
    
    return {
        ok: issues.length === 0,
        issues: issues
    };
}

/**
 * 等待元素出现
 * @param {string} selector 
 * @param {Object} options
 */
function tool_wait_for_element(selector, options = {}) {
    const { timeout = 10000, visible = true, interval = 100 } = options;
    
    return new Promise((resolve) => {
        const startTime = Date.now();
        
        const check = () => {
            try {
                const el = document.querySelector(selector);
                if (el && (!visible || isElementVisible(el))) {
                    resolve({
                        tool: "wait",
                        found: true,
                        selector: selector,
                        waitTime: Date.now() - startTime
                    });
                    return;
                }
            } catch (e) {}
            
            if (Date.now() - startTime >= timeout) {
                resolve({
                    tool: "wait",
                    found: false,
                    selector: selector,
                    timeout: true
                });
                return;
            }
            
            setTimeout(check, interval);
        };
        
        check();
    });
}

/**
 * 获取所有可交互元素
 * @param {Object} options
 */
function tool_get_interactable(options = {}) {
    const { maxResults = 30 } = options;
    
    const interactableSelectors = [
        'button:not([disabled])',
        'a[href]',
        'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="menuitem"]',
        '[onclick]',
        '[tabindex]:not([tabindex="-1"])'
    ];
    
    const results = [];
    const seen = new WeakSet();
    
    for (const sel of interactableSelectors) {
        if (results.length >= maxResults) break;
        
        try {
            const elements = document.querySelectorAll(sel);
            for (const el of elements) {
                if (results.length >= maxResults) break;
                if (seen.has(el)) continue;
                seen.add(el);
                
                if (isElementVisible(el)) {
                    const selector = generateBestSelector(el);
                    results.push({
                        tagName: el.tagName,
                        id: el.id,
                        text: (el.innerText || el.value || el.placeholder || '').substring(0, 40),
                        type: el.type,
                        selector: selector,
                        confidence: calculateSelectorConfidence(selector),
                        interactable: checkInteractable(el)
                    });
                }
            }
        } catch {}
    }
    
    // 按可靠性评分排序
    results.sort((a, b) => b.confidence - a.confidence);
    
    return {
        tool: "interactable",
        count: results.length,
        results: results
    };
}

// ==========================================
// 🌐 挂载到 Window
// ==========================================
window.tool_search_text = tool_search_text;
window.tool_inspect_selector = tool_inspect_selector;
window.tool_smart_select = tool_smart_select;
window.tool_wait_for_element = tool_wait_for_element;
window.tool_get_interactable = tool_get_interactable;
window.generateBestSelector = generateBestSelector;
window.checkInteractable = checkInteractable;
