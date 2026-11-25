// ============================================
// session.js — 当前对话上下文（给本地图片按对话隔离用）
// chatKey 由 index.js 在初始化 / CHAT_CHANGED 时设置。
// 同一段对话（同一个角色/群聊的同一聊天文件）拿到稳定的 key。
// ============================================

let chatKey = '';

export function setChatKey(key) { chatKey = String(key || ''); }
export function getChatKey() { return chatKey || 'default'; }
export function chatPrefix() { return chatKey ? chatKey + '::' : ''; }

// 把对话 key 拼进素材 key，让不同对话的缓存/图集互不干扰。
export function scoped(baseKey) {
    if (!baseKey) return baseKey;
    const k = getChatKey();
    return k === 'default' ? String(baseKey) : k + '::' + String(baseKey);
}

// 从带前缀的 key 里取回原始 key。
// 按当前 chatKey 前缀精确剥离：chatKey 自身可能含 ::（如「角色::玩家」兜底 key），
// 用首个 :: 切会把原始 key 的前半段吃掉。
export function unscope(scopedKey) {
    const s = String(scopedKey || '');
    const p = chatPrefix();
    return p && s.startsWith(p) ? s.slice(p.length) : s;
}
