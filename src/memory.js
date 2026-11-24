// ============================================
// memory.js — 对接酒馆记忆插件（柏宝书 ST-BaiBai-Book），
// 自动把「人物 → 立绘外观」「地点 → 背景」「相貌 → 提示词」关联起来。
//
// 柏宝书暴露只读全局 API：globalThis.STBaiBaiBook
//   getSnapshot() → { state:{location,locationPath}, protagonist, npcs, scenes, ... }
//   subscribe(fn) → 数据变化时通知；另有 st-baibai-book:changed 事件
// 本模块只读取，不写柏宝书的任何数据（它本身也是只读 API）。
//
// 设计原则：
//   1) 只填「空着」或「来源=记忆/自动」的条目，绝不覆盖用户手填的。
//   2) 记忆数据变化时自动增量刷新；没装/没开柏宝书时静默跳过，不影响演出。
//   3) 所有异常都吞掉，绝不让记忆插件把文游拖崩。
// ============================================

import { looksFromMemory, sceneFromMemory } from './looks.js';

let S = null;
let saveFn = null;
let onChanged = null;
let api = null;
let unsub = null;
let readyTimer = null;
let lastSig = '';
let lastStatus = { available: false, revision: 0, people: 0, scenes: 0, text: '未检测到柏宝书' };

const API_NAME = 'STBaiBaiBook';
const READY_EVENT = 'st-baibai-book:ready';
const CHANGE_EVENT = 'st-baibai-book:changed';

function hook() {
    if (onChanged) { try { onChanged(); } catch (e) { /* 忽略 */ } }
}

function getApi() {
    const a = (typeof globalThis !== 'undefined') ? globalThis[API_NAME] : null;
    return (a && typeof a.getSnapshot === 'function') ? a : null;
}

/** 初始化：等柏宝书就绪（加载顺序不固定，先轮询 + 监听 ready 事件） */
export function init(settings, save, hooks = {}) {
    S = settings;
    saveFn = save;
    onChanged = hooks.onChanged || null;

    const start = () => {
        api = getApi();
        if (api) {
            attach();
            syncNow();
        } else {
            lastStatus = { ...lastStatus, text: '柏宝书未安装或未启用' };
        }
    };

    if (typeof window !== 'undefined') {
        window.addEventListener(READY_EVENT, start, { once: true });
        window.addEventListener(CHANGE_EVENT, () => { if (api) scheduleSync(); });
    }
    // 插件可能比我们早加载，也可能晚加载：轮询兜底（前 30 秒每 1s）
    let tries = 0;
    clearInterval(readyTimer);
    readyTimer = setInterval(() => {
        if (api) { clearInterval(readyTimer); return; }
        tries++;
        if (getApi()) { clearInterval(readyTimer); start(); }
        else if (tries >= 30) clearInterval(readyTimer);
    }, 1000);
    // 已经加载好的情况立即跑一次
    start();
}

function attach() {
    if (!api || unsub || typeof api.subscribe !== 'function') return;
    try { unsub = api.subscribe(() => scheduleSync()); } catch (e) { /* 忽略 */ }
}

let syncTimer = null;
function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(), 600);
}

/** 该条目是否允许被记忆数据覆盖（用户手填的永不覆盖） */
function writable(key) {
    const src = (S.lookSource || {})[key];
    // 只覆盖空的或上一次记忆自己填的；手动 / AI 生成的都保留
    return !src || src === 'memory';
}

function markSource(key, src) {
    if (!S.lookSource) S.lookSource = {};
    if (S.lookSource[key] !== src) { S.lookSource[key] = src; return true; }
    return false;
}

/**
 * 立即从柏宝书同步人物外观 / 地点背景到 vn-lite 设置。
 * 返回同步摘要（供设置面板显示）。
 */
export function syncNow() {
    const a = api || getApi();
    if (!a) {
        lastStatus = { ...lastStatus, available: false, text: '柏宝书未安装或未启用' };
        return lastStatus;
    }
    api = a;
    let snap;
    try { snap = a.getSnapshot(); } catch (e) {
        lastStatus = { ...lastStatus, available: false, text: '柏宝书读取失败：' + (e.message || e) };
        return lastStatus;
    }
    if (!snap || typeof snap !== 'object') {
        lastStatus = { ...lastStatus, available: false, text: '柏宝书暂无记忆数据' };
        return lastStatus;
    }

    // 用签名避免无意义重写（revision 变化时才有新数据）
    const sig = [snap.revision || 0, (snap.npcs || []).length, snap.state && snap.state.location].join('|');
    lastStatus = {
        available: true,
        revision: snap.revision || 0,
        people: (snap.npcs || []).length,
        scenes: (snap.scenes || []).length,
        text: '已连接 · ' + ((snap.npcs || []).length) + ' 人物 / ' + ((snap.scenes || []).length) + ' 地点 · rev ' + (snap.revision || 0),
    };
    if (sig === lastSig) return lastStatus;
    lastSig = sig;

    if (!S.memorySync) return lastStatus;   // 用户关掉了自动同步
    let changed = false;

    // ---- 人物 → 立绘外观提示词 ----
    if (!S.artPrompts) S.artPrompts = {};
    for (const npc of (Array.isArray(snap.npcs) ? snap.npcs : [])) {
        const name = String(npc.name || '').trim();
        if (!name || !writable(name)) continue;
        const tags = looksFromMemory(npc);
        if (tags && S.artPrompts[name] !== tags) {
            S.artPrompts[name] = tags;
            if (markSource(name, 'memory')) { /* 来源变了 */ }
            changed = true;
        }
    }
    // 主角（user）：柏宝书 protagonist 没有 name，用酒馆里存的 userName
    const pro = snap.protagonist;
    const me = String(S.userName || S.user || '').trim();
    if (pro && me && writable(me)) {
        const tags = looksFromMemory({ ...pro, gender: pro.gender });
        if (tags && S.artPrompts[me] !== tags) {
            S.artPrompts[me] = tags;
            markSource(me, 'memory');
            changed = true;
        }
    }

    // ---- 地点 → 背景描述 ----
    if (!S.sceneHints) S.sceneHints = {};
    const allScenes = Array.isArray(snap.scenes) ? snap.scenes : [];
    const byName = new Map();
    for (const sc of allScenes) {
        const info = sceneFromMemory(sc);
        if (info && info.name) byName.set(info.name, info);
    }
    const loc = String((snap.state && snap.state.location) || '').trim();
    const path = (snap.state && Array.isArray(snap.state.locationPath)) ? snap.state.locationPath : [];
    const names = [...new Set([loc, ...path])].filter(Boolean);
    for (const name of names) {
        if (!writable('bg:' + name)) continue;
        const sc = byName.get(name);
        const desc = sc ? sc.desc : '';
        // 没有描述时也记个名字，保证当前地点至少能命中背景关键词
        const val = desc ? String(desc).slice(0, 200) : name;
        if (S.sceneHints[name] !== val) {
            S.sceneHints[name] = val;
            markSource('bg:' + name, 'memory');
            changed = true;
        }
    }

    if (changed) {
        try { saveFn && saveFn(); } catch (e) { /* 忽略 */ }
        hook();
    }
    return lastStatus;
}

/** 供设置面板 / 演出调用：当前记忆联动状态 */
export function status() { return lastStatus; }

/** 手动触发（设置面板的「立即同步」按钮） */
export function syncManually() {
    lastSig = '';
    const r = syncNow();
    hook();
    return r;
}

/** 判断某个角色/地点的提示词是不是记忆自动填的（用于 UI 标注） */
export function sourceOf(key) {
    return (S && S.lookSource && S.lookSource[key]) || '';
}

export function dispose() {
    clearInterval(readyTimer);
    clearTimeout(syncTimer);
    try { unsub && unsub(); } catch (e) { /* 忽略 */ }
    unsub = null;
    api = null;
}
