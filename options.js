// 保存设置
const saveBtn = document.getElementById('saveBtn');
const apiKeyInput = document.getElementById('apiKey');
const providerUrlInput = document.getElementById('providerUrl');
const modelNameInput = document.getElementById('modelName');
const statusDiv = document.getElementById('status');

// 初始化：加载现有的 Key & Scripts & Model Config
chrome.storage.local.get(['apiKey', 'userScripts', 'providerUrl', 'modelName'], (result) => {
    if (result.apiKey) {
        apiKeyInput.value = result.apiKey;
    }
    // Set values or defaults
    providerUrlInput.value = result.providerUrl || "https://openrouter.ai/api/v1/chat/completions";
    modelNameInput.value = result.modelName || "google/gemini-2.5-flash";
    
    renderScripts(result.userScripts || []);
});

saveBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    let url = providerUrlInput.value.trim();
    let model = modelNameInput.value.trim();
    
    // Defaults if empty
    if (!url) url = "https://openrouter.ai/api/v1/chat/completions";
    if (!model) model = "google/gemini-2.5-flash";

    if (!key) {
        showStatus('❌ API Key 不能为空', 'error');
        return;
    }

    chrome.storage.local.set({ 
        apiKey: key,
        providerUrl: url,
        modelName: model
    }, () => {
        showStatus('✅ 设置已保存', 'success');
        
        // Update input values to reflect defaults if they were empty
        providerUrlInput.value = url;
        modelNameInput.value = model;

        setTimeout(() => {
            statusDiv.innerText = '';
        }, 2000);
    });
});

function showStatus(msg, type) {
    statusDiv.textContent = msg;
    statusDiv.className = type;
}

// ===========================
// 📜 脚本管理逻辑 (Advanced)
// ===========================
const scriptContainer = document.getElementById("scriptContainer");

function renderScripts(scripts) {
    if (!scripts || scripts.length === 0) {
        scriptContainer.innerHTML = '<p style="color:#999; text-align:center; padding-top:20px;">还没有生成过任何脚本</p>';
        return;
    }

    scriptContainer.innerHTML = "";
    // Show newest first
    scripts.sort((a,b) => b.createdAt - a.createdAt).forEach(script => {
        const item = document.createElement("div");
        item.className = "script-item";
        
        const enabled = script.enabled !== false; // default true
        const statusBadge = enabled 
            ? '<span class="badge badge-on">ON</span>' 
            : '<span class="badge badge-off">OFF</span>';
            
        // Header
        const header = document.createElement("div");
        header.className = "script-header";
        header.innerHTML = `
            <div style="display:flex; align-items:center;">
                <span style="font-weight:bold; font-size:14px; color:#333;">${script.name}</span>
                ${statusBadge}
            </div>
            <div style="font-size:12px; color:#999;">${new Date(script.createdAt).toLocaleDateString()} ▼</div>
        `;
        // Remove old header.onclick, handled in toggleBody
        // header.onclick = ...

        // Body
        const body = document.createElement("div");
        body.className = "script-body";
        body.innerHTML = `
            <div class="editor-label">匹配规则 (Match Pattern)</div>
            <input type="text" class="input-sm matches-input" value="${script.matches}">
            
            <div class="editor-label">代码 (Javascript)</div>
            <div class="code-editor language-javascript" style="overflow:auto; resize:vertical;">Loading...</div>
            
            <!-- History Section -->
            <div style="margin-top:10px;">
                <a href="#" style="font-size:12px; color:#007AFF; text-decoration:none;" id="toggle-history-${script.id}">🕒 查看历史版本 (History)</a>
                <div class="history-list" id="history-list-${script.id}">Loading history...</div>
            </div>

            <div class="action-row">
                 <button class="btn-sm" style="background:${enabled ? '#FF9500' : '#34C759'}" id="toggle-${script.id}">
                    ${enabled ? '禁用 (Disable)' : '启用 (Enable)'}
                 </button>
                 <button class="btn-sm" style="background:#FF3B30;" id="del-${script.id}">删除</button>
                 <button class="btn-sm" style="background:#007AFF;" id="save-${script.id}">保存修改</button>
            </div>
        `;
        
        item.appendChild(header);
        item.appendChild(body);
        scriptContainer.appendChild(item);
        
        // Lazy Load Code & History on toggle
        let codeLoaded = false;
        let jar = null;

        const toggleBody = async () => {
            if(body.style.display === "block") {
                body.style.display = "none";
                header.querySelector("div:last-child").innerText = new Date(script.createdAt).toLocaleDateString() + " ▼";
            } else {
                body.style.display = "block";
                header.querySelector("div:last-child").innerText = "▲";
                
                if (!codeLoaded) {
                     const key = `ujs_${script.id}`;
                     const res = await chrome.storage.local.get(key);
                     const code = res[key] || "// No code found";
                     
                     const editorEl = body.querySelector(".code-editor");
                     // Init CodeJar
                     jar = CodeJar(editorEl, (el) => {
                        // Prism highlight
                        if (window.Prism) {
                             el.innerHTML = Prism.highlight(el.textContent, Prism.languages.javascript, 'javascript');
                        } else {
                             el.textContent = el.textContent;
                        }
                     });
                     
                     jar.updateCode(code);
                     
                     // Render History List
                     renderHistoryList(script, body.querySelector(".history-list"), jar);
                     
                     codeLoaded = true;
                }
            }
        }; 
        
        header.onclick = toggleBody;

        // Toggle History Visibility
        item.querySelector(`#toggle-history-${script.id}`).onclick = (e) => {
            e.preventDefault();
            const list = item.querySelector(`#history-list-${script.id}`);
            list.style.display = list.style.display === "block" ? "none" : "block";
        };
        item.querySelector(`#save-${script.id}`).onclick = () => {
            let newMatches = body.querySelector(".matches-input").value;
            const newCode = jar ? jar.toString() : ""; // get code from jar
            
            // Metadata Parsing Integration
            const meta = parseMetadata(newCode);
            let updates = { code: newCode };
            
            if (meta) {
                if (meta.name) updates.name = meta.name;
                if (meta.match) {
                    updates.matches = meta.match; // Overwrite matches if found in code
                    newMatches = meta.match; // Update local var for UI consistency if needed
                }
                showStatus('ℹ️ Metadata parsed from code', 'success');
            }
            // Always take manual matches input if metadata didn't overwrite it OR let metadata win. 
            // Strategy: logic above lets metadata win if present. If not, use input.
            if (!meta || !meta.match) {
                updates.matches = newMatches; 
            }

            updateScript(script.id, updates);
        };
        
        item.querySelector(`#del-${script.id}`).onclick = () => deleteScript(script.id);
        
        item.querySelector(`#toggle-${script.id}`).onclick = () => {
             updateScript(script.id, { enabled: !enabled });
        };
    });
}

// Update logic (Complex Split Save with History)
async function updateScript(id, changes) {
    const { userScripts } = await chrome.storage.local.get("userScripts");
    const scripts = userScripts || [];
    const index = scripts.findIndex(s => s.id === id);
    
    if (index !== -1) {
        const writes = {};
        let currentScript = scripts[index];

        // 1. Separate Code changes & Push History
        if (changes.code !== undefined) {
            // A. Get Old Code first
            const oldKey = `ujs_${id}`;
            const oldData = await chrome.storage.local.get(oldKey);
            const oldCode = oldData[oldKey] || "";

            // B. Push to History
            if (!currentScript.history) currentScript.history = [];
            currentScript.history.unshift({
                // versionId: crypto.randomUUID(), // simple timestamp is enough for now
                timestamp: Date.now(),
                code: oldCode,
                reason: "Manual Edit"
            });
            // Limit history
            if(currentScript.history.length > 15) currentScript.history = currentScript.history.slice(0, 15);

            writes[oldKey] = changes.code;
            delete changes.code; 
        }

        // 2. Update Metadata
        scripts[index] = { ...currentScript, ...changes, updatedAt: Date.now() };
        writes["userScripts"] = scripts;

        await chrome.storage.local.set(writes);
        showStatus('✅ 更新成功', 'success');
        renderScripts(scripts); 
    }
}

function renderHistoryList(script, listContainer, editor) {
    const history = script.history || [];
    if (history.length === 0) {
        listContainer.innerHTML = '<div style="padding:10px; color:#999; text-align:center;">暂无历史版本</div>';
        return;
    }

    listContainer.innerHTML = "";
    history.forEach((h, idx) => {
        const row = document.createElement("div");
        row.className = "history-item";
        
        const dateStr = new Date(h.timestamp).toLocaleString();
        const reason = h.reason || "Update";
        
        row.innerHTML = `
            <div>
                <span class="history-meta">${idx + 1}.</span> 
                <span style="font-weight:bold; color:#555;">${reason}</span>
                <div class="history-meta" style="font-size:10px;">${dateStr}</div>
            </div>
            <button class="btn-sm" style="background:#5856D6; padding:2px 8px; font-size:10px;">回退 (Rollback)</button>
        `;
        
        row.querySelector("button").onclick = async () => {
            if(!confirm(`确认回退到此版本 (${dateStr})? 当前未保存的代码将丢失。`)) return;
            
            // Rollback Logic
            // We just update the editor value and let user click save, 
            // OR we assume rollback means "save immediately". 
            // Let's do save immediately for convenience.
            
            await updateScript(script.id, { 
                code: h.code, 
                // Don't pollute history with a separate "rollback" entry? 
                // Actually updateScript will allow it as "Manual Edit". That's fine.
            });
            
            // Refresh editor
            if (editor && editor.updateCode) {
                 editor.updateCode(h.code);
            } else if (editor) {
                 // Fallback if editor was passed as element (should not happen with new logic)
                 editor.value = h.code;
            }
        };
        
        listContainer.appendChild(row);
    });
}

function deleteScript(id) {
    if (!confirm("确定要删除这个脚本吗?")) return;
    
    chrome.storage.local.get("userScripts", (result) => {
        const scripts = result.userScripts || [];
        const newScripts = scripts.filter(s => s.id !== id);
        
        // Remove code as well
        chrome.storage.local.remove(`ujs_${id}`);
        
        chrome.storage.local.set({ userScripts: newScripts }, () => {
            renderScripts(newScripts);
            showStatus('🗑️ 脚本已删除', 'success');
        });
    });
}

// 🛠 Helper: Parse Tampermonkey Metadata
function parseMetadata(code) {
    const blockMatch = code.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
    if (!blockMatch) return null;
    
    const block = blockMatch[1];
    const result = {};
    
    // Parse @name
    const nameMatch = block.match(/@name\s+(.*)/);
    if (nameMatch) result.name = nameMatch[1].trim();
    
    // Parse @match (Take the first one found for now)
    const matchMatch = block.match(/@match\s+(.*)/);
    if (matchMatch) result.match = matchMatch[1].trim();

    // Parse @include as fallback
    if (!result.match) {
         const includeMatch = block.match(/@include\s+(.*)/);
         if (includeMatch) result.match = includeMatch[1].trim();
    }
    
    return Object.keys(result).length > 0 ? result : null;
}
