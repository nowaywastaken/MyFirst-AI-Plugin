// ==========================================
// 🕵️‍♂️ DOM 侦探工具集 V3 (Snapshot & Tree)
// ==========================================
// 核心改进：引入 Accessible Tree 和 Snapshot 机制
// 兼容 V2 API

(function() {

// ==========================================
// 📸 Snapshot Generator (V3 Core)
// ==========================================

const AI_ID_ATTR = 'data-ai-id';
let aiIdCounter = 0;

/**
 * 为元素分配唯一的 AI ID
 */
function assignAIID(el) {
    if (!el.hasAttribute(AI_ID_ATTR)) {
        el.setAttribute(AI_ID_ATTR, `ai_${++aiIdCounter}`);
    }
    return el.getAttribute(AI_ID_ATTR);
}

/**
 * 检查元素是否 "有人意" (Interesting to AI)
 */
function isInteresting(el, style) {
    // 交互元素始终有趣
    const tag = el.tagName;
    if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'DETAILS', 'SUMMARY'].includes(tag)) return true;
    
    // 🆕 消息/错误提示元素也很重要 (让 AI 能读取验证结果)
    const classStr = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const roleAttr = el.getAttribute('role') || '';
    if (classStr.includes('error') || classStr.includes('alert') || 
        classStr.includes('message') || classStr.includes('notice') ||
        classStr.includes('warning') || classStr.includes('success') ||
        classStr.includes('feedback') || classStr.includes('validation') ||
        roleAttr === 'alert' || roleAttr === 'status') {
        return true;
    }
    
    if (el.getAttribute('role') && !['presentation', 'none'].includes(el.getAttribute('role'))) return true;
    if (el.onclick || el.getAttribute('onclick')) return true;
    
    // 有文本内容的元素
    if (el.childNodes.length === 1 && el.childNodes[0].nodeType === Node.TEXT_NODE && el.innerText.trim()) return true;
    
    // 容器元素如果也是语义化的，也可以作为结构保留，但为了精简，我们主要保留交互和文本
    // 图片如果有关键属性
    if (tag === 'IMG' && (el.alt || el.title)) return true;

    return false;
}

/**
 * 生成简化的无障碍树 (Accessibility Tree)
 * 返回: { tree: NodeObject, map: Map<AI_ID, Element> }
 */
function buildAccessibilityTree(root = document.body) {
    const elementMap = {}; // ai_id -> element details
    
    function traverse(node, depth = 0) {
        if (!node) return null;
        
        // 1. 深度限制
        if (depth > 50) return null;
        
        // 2. 忽略不可见元素 (Script, Style, Hidden)
        if (node.nodeType === Node.ELEMENT_NODE) {
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH'].includes(node.tagName)) return null;
            if (!isElementVisible(node)) return null;
        }

        // 3. 处理文本节点
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.replace(/\s+/g, ' ').trim();
            return text ? text : null;
        }

        // 4. 处理元素节点
        if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node;
            const aiId = assignAIID(el);
            
            // 收集属性
            const attrs = {
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                // testId: el.getAttribute('data-testid') || undefined,
                role: el.getAttribute('role') || undefined,
                name: el.name || undefined,
                value: el.value || undefined,
                placeholder: el.getAttribute('placeholder') || undefined,
                label: el.getAttribute('aria-label') || undefined,
                disabled: el.disabled ? true : undefined,
                href: el.href ? '[LINK]' : undefined // 简化 href
            };
            
            // 🌟 增强：多模式 Label 语义检测 (Enhanced Semantic Label Detection)
            if (['input', 'select', 'textarea'].includes(attrs.tag)) {
                let labelText = null;
                
                // 1. 检查 <label for="id">
                if (el.id) {
                    const labelEl = document.querySelector(`label[for="${el.id}"]`);
                    if (labelEl) labelText = labelEl.innerText;
                }
                
                // 2. 检查父级 <label>
                if (!labelText) {
                    const parentLabel = el.closest('label');
                    if (parentLabel) {
                        const clone = parentLabel.cloneNode(true);
                        const selfClone = clone.querySelector(el.tagName);
                        if (selfClone) selfClone.remove();
                        labelText = clone.innerText;
                    }
                }
                
                // 3. 🆕 检查 aria-labelledby
                if (!labelText && el.getAttribute('aria-labelledby')) {
                    const ids = el.getAttribute('aria-labelledby').split(/\s+/);
                    const texts = ids.map(id => document.getElementById(id)?.innerText).filter(Boolean);
                    if (texts.length > 0) labelText = texts.join(' ');
                }
                
                // 4. 🆕 检查相邻的标签元素（前面的 span, div, p, label, strong）
                if (!labelText) {
                    const prev = el.previousElementSibling;
                    if (prev && ['SPAN', 'DIV', 'P', 'LABEL', 'STRONG', 'B'].includes(prev.tagName)) {
                        const prevText = prev.innerText?.trim();
                        if (prevText && prevText.length < 100) labelText = prevText;
                    }
                }
                
                // 5. 🆕 检查前置文本节点（常见于简单表单）
                if (!labelText) {
                    const prevNode = el.previousSibling;
                    if (prevNode && prevNode.nodeType === Node.TEXT_NODE) {
                        const text = prevNode.textContent?.trim();
                        if (text && text.length > 2 && text.length < 100) labelText = text;
                    }
                }
                
                // 6. 🆕 使用 placeholder 作为备用描述
                if (!labelText && el.placeholder) {
                    labelText = `[placeholder: ${el.placeholder}]`;
                }
                
                if (labelText) {
                    attrs.visual_label = labelText.replace(/\s+/g, ' ').trim().substring(0, 80);
                }
                
                // 7. 🆕 视觉提示检测（特殊边框颜色等）
                try {
                    const style = window.getComputedStyle(el);
                    const borderColor = style.borderColor;
                    // 检测非默认边框颜色（如蓝色高亮 #2196F3 或 rgb(33, 150, 243)）
                    if (borderColor && !borderColor.includes('rgb(0, 0, 0)') && 
                        !borderColor.includes('rgb(128, 128, 128)') &&
                        !borderColor.includes('rgb(204, 204, 204)')) {
                        // 检测蓝色系
                        if (borderColor.includes('rgb(33, 150, 243)') || 
                            borderColor.includes('#2196F3') ||
                            borderColor.includes('rgb(25, 118, 210)')) {
                            attrs.visual_hint = 'highlighted-blue';
                        }
                    }
                } catch (e) { /* ignore style errors */ }
            }
            
            // 清理 undefined
            Object.keys(attrs).forEach(key => attrs[key] === undefined && delete attrs[key]);

            const children = [];
            
            // 处理 Shadow DOM
            const childSource = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
            
            for (const child of childSource) {
                const result = traverse(child, depth + 1);
                if (result) {
                    if (typeof result === 'string') {
                        // 合并相邻文本
                        const last = children[children.length - 1];
                        if (typeof last === 'string') {
                            children[children.length - 1] = last + ' ' + result;
                        } else {
                            children.push(result);
                        }
                    } else {
                        children.push(result);
                    }
                }
            }

            // 决策：是否保留此节点？
            // 规则：如果是交互元素，或者包含“有趣”的子节点，或者自身有文本
            const isInteractive = ['button', 'a', 'input', 'select', 'textarea', 'label'].includes(attrs.tag) || attrs.role === 'button';
            const hasContent = children.length > 0;
            
            if (isInteractive || hasContent) {
                // 构建树节点
                const treeNode = {
                    _id: aiId,
                    ...attrs
                };
                
                if (children.length > 0) {
                    // 如果只有一个文本子节点，直接提升属性
                    if (children.length === 1 && typeof children[0] === 'string') {
                        treeNode.text = children[0];
                    } else {
                        treeNode.children = children;
                    }
                }
                
                // 保存到映射表 (供执行器反查)
                elementMap[aiId] = {
                    selector: generateBestSelector(el),
                    raw: el // 注意：无法序列化回 background，只能存 selector
                };
                
                return treeNode;
            }
            
            return null;
        }
        
        return null;
    }

    const tree = traverse(root);
    return { tree, elementMap };
}

/**
 * 生成页面快照 (供 AI 使用)
 */
function generateSnapshot() {
    // 🔧 重置计数器确保每次快照的 ID 从头开始 (Fix: AI ID Consistency)
    aiIdCounter = 0;
    // 清除旧的 ai-id 属性，防止残留导致混乱
    document.querySelectorAll('[data-ai-id]').forEach(el => el.removeAttribute('data-ai-id'));
    
    const { tree, elementMap } = buildAccessibilityTree(document.body);
    
    // 将 tree 转为一种紧凑的字符串表示 (Pseudo-HTML)
    function renderTree(node, indent = 0) {
        if (typeof node === 'string') return '  '.repeat(indent) + node;
        
        let line = '  '.repeat(indent) + `<${node.tag}`;
        if (node._id) line += ` ai-id="${node._id}"`;
        if (node.id) line += ` id="${node.id}"`;
        // if (node.testId) line += ` test-id="${node.testId}"`;
        if (node.name) line += ` name="${node.name}"`;
        if (node.role) line += ` role="${node.role}"`;
        if (node.value) line += ` value="${node.value}"`;
        if (node.placeholder) line += ` placeholder="${node.placeholder}"`;
        if (node.label) line += ` aria-label="${node.label}"`;
        if (node.visual_label) line += ` visual_label="${node.visual_label}"`; // 🌟 新增
        if (node.visual_hint) line += ` visual_hint="${node.visual_hint}"`; // 🆕 视觉提示
        if (node.disabled) line += ` disabled`;
        if (node.href) line += ` href`;
        
        if (node.text) {
            line += `>${node.text}</${node.tag}>`;
        } else if (node.children && node.children.length > 0) {
            line += `>`;
            const childrenStr = node.children.map(c => renderTree(c, indent + 1)).join('\n');
            line += '\n' + childrenStr + '\n' + '  '.repeat(indent) + `</${node.tag}>`;
        } else {
            line += ` />`;
        }
        return line;
    }

    return {
        domTree: renderTree(tree),
        interactiveMap: elementMap, // Map<ai-id, {selector}>
        contentHash: generateContentHash() // 🌟 State Hash
    };
}

/**
 * 计算页面内容指纹 (Simple & Fast)
 */
function generateContentHash() {
    // 组合因素：URL + Title + Body Length + Interactive Count
    // 我们不需要 crypto grade hash，只需要感知变化的指纹
    const factors = [
        window.location.href,
        document.title,
        document.body.innerText.length,
        document.querySelectorAll('input, button, a').length
    ];
    return factors.join('|');
}


// ==========================================
// 🔍 辅助函数 (Utils)
// ==========================================

/**
 * 检查元素是否可见
 */
function isElementVisible(el) {
    if (!el) return false;
    try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        
        // 视口检查 (V3新增)
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        
        // 简单的视口交叉检查 (不严格要求完全在视口内，只要在滚动区域内即可)
        // 但对于 "display: none" 的父级检测很重要，checkInteractable 已经做了
        return true;
    } catch {
        return false;
    }
}

/**
 * 增强版 Selector 生成器 (V3)
 */
function generateBestSelector(el) {
    if (!el) return null;
    
    // 1. 全局唯一 ID (最强)
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) { // 确保 ID 格式合法且不包含乱码
        return `#${el.id}`;
    }
    
    // 2. Test ID (最稳)
    const testIdAttrs = ['data-testid', 'data-test', 'data-cy', 'data-qa'];
    for (const attr of testIdAttrs) {
        if (el.hasAttribute(attr)) {
            return `[${attr}="${el.getAttribute(attr)}"]`;
        }
    }
    
    // 3. 语义化属性
    if (el.name && document.getElementsByName(el.name).length === 1) {
        return `[name="${el.name}"]`;
    }
    if (el.getAttribute('aria-label')) {
        const label = el.getAttribute('aria-label');
        if (document.querySelectorAll(`[aria-label="${label}"]`).length === 1) {
           return `[aria-label="${label}"]`;
        }
    }
    
    // 4. 路径回退 (Path Backup)
    let path = el.tagName.toLowerCase();
    
    // 尝试添加 class
    if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(/\s+/).filter(c => c && !c.includes(':') && !c.match(/^[0-9]/));
        if (classes.length > 0) {
            path += '.' + classes[0]; // 只取第一个 class
        }
    }
    
    // nth-child
    const parent = el.parentElement;
    if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        if (siblings.length > 1) {
             const idx = Array.prototype.indexOf.call(parent.children, el) + 1;
             path += `:nth-child(${idx})`;
        }
        
        // 向上递归一层，增加稳定性
        if (parent.id) {
            return `#${parent.id} > ${path}`;
        }
    }
    
    return path;
}

// ==========================================
// 🛡️ 兼容 V2 接口 (Legacy Support)
// ==========================================
// 保持原有接口，防止 executor.js 报错

const SELECTION_STRATEGIES = [
    { name: 'testId', find: (q) => document.querySelector(`[data-testid="${q}"], [data-test="${q}"]`) },
    { name: 'id', find: (q) => document.getElementById(q) },
    { name: 'xpath_text', find: (q) => null }, // 简化
    { name: 'css', find: (q) => { try { return document.querySelector(q) } catch{ return null } } }
];

function tool_smart_select(query) {
    // 快速实现，V3 主要靠 Snapshot
    try {
        const el = document.querySelector(query);
        if (el) return { found: true, selector: generateBestSelector(el) };
    } catch(e) {}
    return { found: false };
}

// 导出到全局
window.SnapshotGenerator = {
    generateSnapshot,
    assignAIID,
    buildAccessibilityTree
};

// 兼容旧 API
window.tool_smart_select = tool_smart_select;
window.generateBestSelector = generateBestSelector;
window.isElementVisible = isElementVisible;

})();
