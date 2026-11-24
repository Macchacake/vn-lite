// ============================================
// localstore.js — 把生成的图片真正下载到手机本地（IndexedDB）
// 目的：
//   1) 隧道关掉 / ComfyUI 关掉 / 换地址后，图依然能看；
//   2) 图片和对话绑定，切到别的对话看不到这段对话的图。
// 只存 blob 到 IndexedDB（localStorage 容量不够），内存里再维护一份
// objectURL 映射，供同步的 viewUrl()/urlOf() 直接使用。
// 任何异常都静默降级回远程地址，绝不让演出崩掉。
// ============================================

const DB_NAME = 'vnl_media';
const DB_VER = 1;
const STORE = 'imgs';
const MAX_PER_CHAT = 120;      // 每个对话最多留多少张本地图，超了淘汰最旧的

let db = null;
let opened = false;
const urlMap = new Map();      // id -> objectURL（当前已 hydrate 的）
const saving = new Set();      // 正在下载的 id，防重复

function idb() {
    if (opened) return Promise.resolve(db);
    opened = true;
    return new Promise((resolve) => {
        try {
            if (typeof indexedDB === 'undefined') { db = null; return resolve(null); }
            const req = indexedDB.open(DB_NAME, DB_VER);
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains(STORE)) {
                    const os = d.createObjectStore(STORE, { keyPath: 'id' });
                    os.createIndex('chatId', 'chatId', { unique: false });
                    os.createIndex('ts', 'ts', { unique: false });
                }
            };
            req.onsuccess = () => { db = req.result; resolve(db); };
            req.onerror = () => { db = null; resolve(null); };
        } catch (e) { db = null; resolve(null); }
    });
}

function txRun(mode, fn) {
    return idb().then(d => new Promise((resolve) => {
        if (!d) return resolve(null);
        let out = null;
        try {
            const tx = d.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            if (req) req.onsuccess = () => { out = req.result; };
            tx.oncomplete = () => resolve(out);
            tx.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
        } catch (e) { resolve(null); }
    }));
}

// 把某张图下载到本地。url 是 ComfyUI 的 /view 地址。
export function saveFromUrl(id, url, meta) {
    if (!id || !url || saving.has(id)) return Promise.resolve(false);
    // 注意：这里不能因为已有副本就跳过。画风切换/手动清缓存后会重新生成同一 key，
    // 必须把新图覆盖下去，否则本地永远停在旧图。
    saving.add(id);
    return fetch(url, { cache: 'force-cache' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(blob => {
            if (!blob || !blob.size) throw new Error('empty blob');
            const rec = {
                id,
                chatId: meta?.chatId || '',
                kind: meta?.kind || '',
                key: meta?.key || '',
                prompt: meta?.prompt || '',
                blob,
                ts: Date.now(),
            };
            return txRun('readwrite', os => os.put(rec)).then(ok => {
                if (ok === null) return false;
                try {
                    const prev = urlMap.get(id);
                    if (prev) { try { URL.revokeObjectURL(prev); } catch (e) { /* ignore */ } }
                    const u = URL.createObjectURL(blob);
                    urlMap.set(id, u);
                } catch (e) { /* objectURL 失败就用远程地址 */ }
                return true;
            });
        })
        .catch(() => false)
        .finally(() => { saving.delete(id); });
}

// 读取一次对话的所有本地图，重建 objectURL（页面重启后必须调用）
export function hydrate(chatId) {
    return txRun('readonly', os => os.index('chatId').getAll(IDBKeyRange.only(chatId)))
        .then(rows => {
            // 释放上一批 objectURL，避免内存泄漏
            for (const u of urlMap.values()) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } }
            urlMap.clear();
            if (!Array.isArray(rows)) return 0;
            // 只保留最近 N 张
            const keep = rows.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, MAX_PER_CHAT);
            for (const r of keep) {
                if (!r || !r.blob || !r.id) continue;
                try { urlMap.set(r.id, URL.createObjectURL(r.blob)); } catch (e) { /* ignore */ }
            }
            return keep.length;
        })
        .catch(() => 0);
}

export function peekUrl(id) { return id ? (urlMap.get(id) || null) : null; }

export function hasLocal(id) { return urlMap.has(id); }

// 列出某个对话的本地记录（含 id/kind/key/prompt/blob），供图集使用
export function listChat(chatId) {
    return txRun('readonly', os => os.index('chatId').getAll(IDBKeyRange.only(chatId)))
        .then(rows => Array.isArray(rows) ? rows : [])
        .catch(() => []);
}

export function remove(id) {
    if (!id) return Promise.resolve(false);
    const u = urlMap.get(id);
    if (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } urlMap.delete(id); }
    return txRun('readwrite', os => os.delete(id)).then(r => r !== null).catch(() => false);
}

export function clearChat(chatId) {
    return txRun('readonly', os => os.index('chatId').getAllKeys(IDBKeyRange.only(chatId)))
        .then(keys => {
            if (Array.isArray(keys)) for (const k of keys) {
                const u = urlMap.get(k);
                if (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } urlMap.delete(k); }
            }
            return txRun('readwrite', os => {
                if (!Array.isArray(keys)) return null;
                for (const k of keys) os.delete(k);
                return keys.length;
            });
        })
        .catch(() => false);
}

export function count() { return urlMap.size; }

export function supported() { return typeof indexedDB !== 'undefined'; }
