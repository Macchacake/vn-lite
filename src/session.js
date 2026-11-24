// ============================================
// session.js — 当前对话上下文（给本地图片按对话隔离用）
// chatKey 由 index.js 在初始化 / CHAT_CHANGED 时设置。
// 同一段对话（同一个角色/群聊的同一聊天文件）拿到稳定的 key。
// ============================================

let chatKey = '';

export function setChatKey(key) { chatKey = String(key || ''); }
export function getChatKey() { return chatKey || 'default'; }

// 把对话 key 拼进素材 key，让不同对话的缓存/图集互不干扰。
export function scoped(baseKey) {
    if (!baseKey) return baseKey;
    const k = getChatKey();
    return k === 'default' ? String(baseKey) : k + '::' + String(baseKey);
}

// 从带前缀的 key 里取回原始 key（图集显示用）
export function unscope(scopedKey) {
    const s = String(scopedKey || '');
    const i = s.indexOf('::');
    return i >= 0 ? s.slice(i + 2) : s;
}
