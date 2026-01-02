// ==========================================
// 🧠 Session Memory System (V5)
// ==========================================
// ChatGPT-style: Each task = One session
// Persistent within session, isolated between sessions

const SESSION_STORAGE_KEY = 'sessionMemory';
const MAX_SESSIONS_STORED = 10; // Keep last 10 sessions
const CONTEXT_WINDOW_SIZE = 15; // Send last 15 steps to AI

/**
 * 生成唯一会话 ID
 */
function generateSessionId() {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * 获取所有会话存储
 */
async function getSessionStore() {
    const data = await chrome.storage.local.get(SESSION_STORAGE_KEY);
    return data[SESSION_STORAGE_KEY] || { sessions: {}, activeSessionId: null };
}

/**
 * 保存会话存储
 */
async function saveSessionStore(store) {
    await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: store });
}

/**
 * 创建新会话
 */
async function createSession(goal, tabId, url) {
    const store = await getSessionStore();
    
    // 结束之前的活跃会话
    if (store.activeSessionId && store.sessions[store.activeSessionId]) {
        store.sessions[store.activeSessionId].status = 'abandoned';
        store.sessions[store.activeSessionId].endedAt = Date.now();
    }
    
    const sessionId = generateSessionId();
    
    store.sessions[sessionId] = {
        id: sessionId,
        goal: goal,
        startedAt: Date.now(),
        endedAt: null,
        status: 'running',
        tabId: tabId,
        url: url,
        steps: [],
        milestones: [], // 🎯 里程碑机制
        observations: [],
        goalStack: [goal],
        lastPageHash: null
    };
    
    store.activeSessionId = sessionId;
    
    // 清理旧会话
    const sessionIds = Object.keys(store.sessions);
    if (sessionIds.length > MAX_SESSIONS_STORED) {
        const sorted = sessionIds.sort((a, b) => 
            store.sessions[a].startedAt - store.sessions[b].startedAt
        );
        const toDelete = sorted.slice(0, sessionIds.length - MAX_SESSIONS_STORED);
        toDelete.forEach(id => delete store.sessions[id]);
    }
    
    await saveSessionStore(store);
    console.log(`📝 Session created: ${sessionId}`);
    return sessionId;
}

/**
 * 添加步骤到当前会话
 */
async function addStep(sessionId, step) {
    const store = await getSessionStore();
    const session = store.sessions[sessionId];
    
    if (!session) {
        console.warn('Session not found:', sessionId);
        return false;
    }
    
    session.steps.push({
        idx: session.steps.length + 1,
        action: step.action,
        target: step.target,
        value: step.value,
        description: step.description,
        result: step.result || 'UNKNOWN', // PAGE_CHANGED, PAGE_SAME, FAILED
        success: step.success,
        error: step.error,
        timestamp: Date.now()
    });
    
    await saveSessionStore(store);
    return true;
}

/**
 * 更新目标栈
 */
async function updateGoalStack(sessionId, newStack) {
    const store = await getSessionStore();
    const session = store.sessions[sessionId];
    
    if (!session) return false;
    
    session.goalStack = newStack;
    await saveSessionStore(store);
    return true;
}

/**
 * 添加观察（AI 的洞察）
 */
async function addObservation(sessionId, observation) {
    const store = await getSessionStore();
    const session = store.sessions[sessionId];
    
    if (!session) return false;
    
    session.observations.push({
        text: observation,
        timestamp: Date.now()
    });
    
    // 限制观察数量
    if (session.observations.length > 20) {
        session.observations = session.observations.slice(-20);
    }
    
    await saveSessionStore(store);
    return true;
}

/**
 * 🎯 添加里程碑（关键进度点）
 */
async function addMilestone(sessionId, milestone) {
    const store = await getSessionStore();
    const session = store.sessions[sessionId];
    
    if (!session) return false;
    
    session.milestones.push({
        label: milestone,
        stepIdx: session.steps.length,
        timestamp: Date.now()
    });
    
    console.log(`🎯 Milestone: ${milestone}`);
    await saveSessionStore(store);
    return true;
}

/**
 * 获取所有里程碑
 */
async function getMilestones(sessionId) {
    const store = await getSessionStore();
    const session = store.sessions[sessionId];
    
    return session?.milestones || [];
}

/**
 * 获取会话上下文（供 AI Prompt 使用）
 */
async function getContext(sessionId, windowSize = CONTEXT_WINDOW_SIZE) {
    const store = await getSessionStore();
    const session = store.sessions[sessionId];
    
    if (!session) {
        return {
            goal: 'Unknown',
            goalStack: [],
            recentSteps: [],
            observations: [],
            stepCount: 0
        };
    }
    
    // 滑动窗口：只返回最近 N 步
    const recentSteps = session.steps.slice(-windowSize);
    
    return {
        goal: session.goal,
        goalStack: session.goalStack,
        milestones: session.milestones || [], // 🎯
        recentSteps: recentSteps,
        observations: session.observations.slice(-5), // 最近 5 条观察
        stepCount: session.steps.length,
        url: session.url,
        startedAt: session.startedAt
    };
}

/**
 * 获取活跃会话
 */
async function getActiveSession() {
    const store = await getSessionStore();
    
    if (!store.activeSessionId) return null;
    
    return store.sessions[store.activeSessionId] || null;
}

/**
 * 获取活跃会话 ID
 */
async function getActiveSessionId() {
    const store = await getSessionStore();
    return store.activeSessionId;
}

/**
 * 结束会话
 */
async function endSession(sessionId, status = 'completed') {
    const store = await getSessionStore();
    const session = store.sessions[sessionId];
    
    if (!session) return false;
    
    session.status = status; // completed, failed, stopped
    session.endedAt = Date.now();
    
    if (store.activeSessionId === sessionId) {
        store.activeSessionId = null;
    }
    
    await saveSessionStore(store);
    console.log(`📕 Session ended: ${sessionId} (${status})`);
    return true;
}

/**
 * 更新页面哈希
 */
async function updatePageHash(sessionId, hash) {
    const store = await getSessionStore();
    const session = store.sessions[sessionId];
    
    if (!session) return false;
    
    session.lastPageHash = hash;
    await saveSessionStore(store);
    return true;
}

/**
 * 获取上一次页面哈希
 */
async function getLastPageHash(sessionId) {
    const store = await getSessionStore();
    const session = store.sessions[sessionId];
    
    return session?.lastPageHash || null;
}

/**
 * 检查是否有活跃会话
 */
async function hasActiveSession() {
    const store = await getSessionStore();
    return !!store.activeSessionId;
}

/**
 * 获取所有会话（用于调试/UI）
 */
async function getAllSessions() {
    const store = await getSessionStore();
    return Object.values(store.sessions).sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * 清除所有会话
 */
async function clearAllSessions() {
    await chrome.storage.local.remove(SESSION_STORAGE_KEY);
}

// 导出
if (typeof self !== 'undefined') {
    self.SessionMemory = {
        createSession,
        addStep,
        updateGoalStack,
        addObservation,
        addMilestone, // 🎯
        getMilestones, // 🎯
        getContext,
        getActiveSession,
        getActiveSessionId,
        endSession,
        updatePageHash,
        getLastPageHash,
        hasActiveSession,
        getAllSessions,
        clearAllSessions,
        CONTEXT_WINDOW_SIZE
    };
}
