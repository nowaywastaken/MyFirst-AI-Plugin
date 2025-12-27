// ==========================================
// 🕵️‍♂️ DOM 侦探工具集 (注入到页面运行)
// ==========================================

/**
 * 在页面中搜索包含特定文本的元素
 * @param {string} query - 搜索关键词
 * @returns {Array} - 候选元素列表
 */
/**
 * 在页面中搜索包含特定文本的元素 (支持 Shadow DOM)
 * @param {string} query - 搜索关键词
 * @returns {Array} - 候选元素列表
 */
function tool_search_text(query) {
    if (!query) return { error: "Query is empty" };
    
    // 限制结果数量防止 Token 爆炸
    const maxResults = 10; 
    const results = [];
    const lowerQuery = query.toLowerCase();

    /**
     * 递归遍历节点的 Walker
     * @param {Node} root 
     */
    function walk(root) {
        if (results.length >= maxResults) return;
        if (!root) return;

        // 1. Check current node (if Element)
        if (root.nodeType === Node.ELEMENT_NODE) {
            const el = root;
            
            // Skip invisible or script/style
            if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) return;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return;

            // Check Content
            // 策略：检查直接文本节点
            let match = false;
            let content = "";
            
            for (let node of el.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    const txt = node.textContent.trim();
                    if (txt.toLowerCase().includes(lowerQuery)) {
                        match = true;
                        content = txt;
                        break;
                    }
                }
            }
            
            // 辅助策略：如果你是 img, input 且 alt/placeholder 匹配
            if (!match) {
                 if (el.tagName === 'IMG' && (el.alt || "").toLowerCase().includes(lowerQuery)) {
                     match = true; content = `[IMG alt="${el.alt}"]`;
                 }
                 if (el.tagName === 'INPUT' && (el.placeholder || "").toLowerCase().includes(lowerQuery)) {
                     match = true; content = `[INPUT ph="${el.placeholder}"]`;
                 }
            }

            if (match) {
                // 生成路径
                let selector = el.tagName.toLowerCase();
                if (el.id) selector += `#${el.id}`;
                if (el.className && typeof el.className === 'string') {
                    const classes = el.className.split(/\s+/).filter(c => c.trim().length > 0).join('.');
                    if (classes) selector += `.${classes}`;
                }

                results.push({
                    tagName: el.tagName,
                    id: el.id,
                    className: typeof el.className === 'string' ? el.className : "[SVG/Complex]",
                    text: content.substring(0, 60), 
                    selector: selector,
                    inShadow: !!root.getRootNode && (root.getRootNode() instanceof ShadowRoot)
                });
            }
            
            // 2. Traverse Shadow Root
            if (el.shadowRoot) {
                walk(el.shadowRoot);
            }
        }

        // 3. Traverse Children
        let child = root.firstChild;
        while (child) {
            walk(child);
            child = child.nextSibling;
        }
    }

    // Start walking from Body
    walk(document.body);
    
    return {
        tool: "search",
        query: query,
        location: window.location.href, // 告诉 AI 我是在哪个 frame
        count: results.length,
        results: results
    };
}

/**
 * 检查特定 Selector 的详细结构
 * @param {string} selector 
 */
function tool_inspect_selector(selector) {
    if (!selector) return { error: "Selector is empty" };
    
    let el;
    try {
        el = document.querySelector(selector);
    } catch(e) {
        return { error: "Invalid selector" };
    }
    
    if (!el) return { error: "Element not found" };
    
    // 获取 computed style 关键属性
    const style = window.getComputedStyle(el);
    
    // 获取父级链 (向上找 3 层)
    const parents = [];
    let curr = el.parentElement;
    for (let i=0; i<3; i++) {
        if (!curr) break;
        parents.push({
            tagName: curr.tagName,
            id: curr.id,
            className: curr.className
        });
        curr = curr.parentElement;
    }
    
    return {
        tool: "inspect",
        found: true,
        tagName: el.tagName,
        id: el.id,
        className: el.className,
        innerHTML_snippet: el.innerHTML.substring(0, 200).replace(/\n/g, ""), // 也是截断
        rect: { width: el.offsetWidth, height: el.offsetHeight },
        styles: {
            display: style.display,
            visibility: style.visibility, 
            position: style.position,
            zIndex: style.zIndex
        },
        parents: parents
    };
}

// 挂载到 Window 以便 Background 调用
window.tool_search_text = tool_search_text;
window.tool_inspect_selector = tool_inspect_selector;
