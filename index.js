// ============================================
// 文游Lite (VN-Lite) — SillyTavern 原生扩展入口
// 轻量视觉小说界面：智能/协议双模式、剪影立绘、
// 打字机、氛围音乐、全屏剧场、剧情小游戏。
// ============================================

import {
    eventSource,
    event_types,
    chat,
    characters,
    name1,
    name2,
    saveSettingsDebounced,
    setExtensionPrompt,
    getThumbnailUrl,
} from '../../../../script.js';
import { extension_settings } from '../../../../scripts/extensions.js';
import { groups, selected_group } from '../../../../scripts/group-chats.js';

import * as settings from './src/settings.js';
import * as art from './src/art.js';
import * as gallery from './src/gallery.js';
import { parseMessage, resetLearned } from './src/parser.js';
import { openTheater, closeTheater, appendTheater, isOpen } from './src/theater.js';
import { buildProtocol } from './src/protocol.js';
import { bgm } from './src/bgm.js';

const PROTOCOL_KEY = 'vnLiteProtocol';

// ---------- 协议提示词（注入给 AI 的演出规范，可在设置里整段修改） ----------
function applyProtocolInjection() {
    const S = settings.get();
    const on = S.enabled && S.mode === 'protocol';
    try {
        setExtensionPrompt(PROTOCOL_KEY, on ? buildProtocol(S) : '', 0, 0, false);
    } catch (e) {
        console.warn('[VN-Lite] 协议注入失败', e);
    }
}

// ---------- 上下文信息 ----------
function getCtxInfo() {
    const members = [];
    try {
        if (selected_group) {
            const g = groups.find(x => x.id == selected_group);
            if (g && Array.isArray(g.members)) {
                for (const mid of g.members) {
                    const c = characters[mid];
                    if (c && c.name) members.push(c.name);
                }
            }
        }
    } catch { /* 群组信息不可用时忽略 */ }
    return { charName: name2, userName: name1, members, chunk: settings.get().chunk || 60 };
}

// ---------- 素材解析：映射表 → 角色头像 → null（剪影） ----------
function resolveChar(name) {
    if (!name) return null;
    const S = settings.get();
    if (S.maps.chars[name]) return S.maps.chars[name];
    try {
        // 当前角色精确/包含匹配
        for (let i = 0; i < characters.length; i++) {
            const c = characters[i];
            if (c && c.avatar && c.name && (c.name === name || c.name.includes(name) || name.includes(c.name))) {
                return getThumbnailUrl('avatar', c.avatar);
            }
        }
    } catch { /* 头像解析失败 → 剪影 */ }
    return null;
}

// ---------- 发送玩家选择 ----------
function sendUserMessage(text) {
    const ta = document.querySelector('#send_textarea');
    if (!ta) return;
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.querySelector('#sendbut') || document.querySelector('#send_but');
    if (btn) btn.click();
}

// ---------- 环境工厂（每次挂载取最新设置） ----------
function envFactory() {
    return {
        settings: settings.get(),
        ctxInfo: getCtxInfo(),
        userName: name1,
        resolveChar,
        sendUserMessage,
        // CG 绘画：先查缓存，再按需生成（URL/开关实时生效）
        sd: (prompt) => art.cg(prompt),
        openTheater: (script) => {
            openTheater([{ script, title: name2 || '演出' }], envFactory);
        },
    };
}

// ---------- 渲染调度 ----------
let generating = false;

// ---------- 剧场同层追加（不退出剧场继续剧情） ----------
let _appendedSig = '';
function appendLatestToTheater() {
    let last = null, lastId = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && m.mes && m.mes.trim()) { last = m; lastId = i; break; }
    }
    if (!last) return;
    const sig = lastId + ':' + (last.swipe_id ?? '') + ':' + last.mes.length;
    if (sig === _appendedSig) return; // 同一条消息（流式/重复事件）不重复追加
    _appendedSig = sig;
    const script = parseMessage(last.mes, getCtxInfo());
    if (script && script.usable) {
        appendTheater(script, name2 || '演出');
        try { art.prefetch(script); } catch (e) { /* 预生成失败不影响演出 */ }
    }
}

// ---------- 文游模式入口 ----------
function buildTheaterItems() {
    const ids = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (m && !m.is_user && m.mes && m.mes.trim()) ids.push(i);
    }
    const recent = ids.slice(-Math.max(1, settings.get().historyCount || 6));
    const items = [];
    for (const id of recent) {
        const script = parseMessage(chat[id].mes, getCtxInfo());
        if (script && script.usable) items.push({ script, title: name2 || '演出' });
    }
    return items;
}

function enterVnMode() {
    if (isOpen()) return;
    openTheater(buildTheaterItems(), envFactory, { startAtEnd: true });
}

// 在右下角魔棒菜单里加一个入口
function installWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById('vnl-wand-btn')) return true;

    const item = document.createElement('div');
    item.id = 'vnl-wand-btn';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.title = '进入文游模式';
    item.innerHTML = '<span style="font-size:18px;line-height:1">🎭</span><span>文游模式</span>';
    const go = () => enterVnMode();
    item.addEventListener('click', go);
    item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
    menu.appendChild(item);
    return true;
}

// 酒馆有时会重建 #extensionsMenu（比如保存设置、重载扩展），
// 我们塞进去的按钮会被一起清掉，所以用 MutationObserver 兜住。
function watchWandMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || menu.dataset.vnlWatched) return;
    menu.dataset.vnlWatched = '1';
    try {
        const obs = new MutationObserver(() => {
            if (!document.getElementById('vnl-wand-btn')) installWandButton();
        });
        obs.observe(menu, { childList: true });
    } catch (e) {
        console.warn('[VN-Lite] 魔棒菜单监听失败', e);
    }
}

function waitForWandButton() {
    const wand = document.getElementById('extensionsMenuButton');
    if (wand && !wand.dataset.vnlBound) {
        wand.dataset.vnlBound = '1';
        wand.addEventListener('click', () => setTimeout(() => {
            installWandButton();
            watchWandMenu();
        }, 60));
    }
    watchWandMenu();
    if (installWandButton()) return;
    let tries = 0;
    const timer = setInterval(() => {
        watchWandMenu();
        if (installWandButton() || ++tries > 60) clearInterval(timer);
    }, 500);
}

// ---------- 启动 ----------
async function init() {
    settings.init(extension_settings, saveSettingsDebounced, {
        onChanged: (S) => {
            applyProtocolInjection();
            bgm.setEnabled(S.bgmOn);
            bgm.setVolume(S.bgmVol);
        },
    });

    // 美术总监 / 图集：共享同一份设置对象
    art.init(settings.get());
    gallery.init(settings.get());

    // BGM 初始状态 + 解锁
    bgm.setEnabled(settings.get().bgmOn);
    bgm.setVolume(settings.get().bgmVol);
    bgm.attachUnlock();

    // 协议注入（扩展加载即生效）
    applyProtocolInjection();

    // 清理旧版本可能留在聊天里的内嵌舞台，保证退出文游后看到原聊天
    document.querySelectorAll('.mes_text.vnl-active').forEach(el => el.classList.remove('vnl-active'));
    document.querySelectorAll('.vnl-stage').forEach(el => el.remove());

    // 魔棒菜单入口（ST 的菜单可能比扩展晚就绪，轮询安装）
    waitForWandButton();

    // 生成中标记：生成结束后把最新回复追加为文游新幕
    eventSource.on(event_types.GENERATION_STARTED, () => { generating = true; });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        generating = false;
        setTimeout(() => appendLatestToTheater(), 400);
    });

    // 新消息（非流式 / 首条消息）
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        if (generating) return; // 流式结束时由 GENERATION_ENDED 处理
        setTimeout(() => appendLatestToTheater(), 300);
    });

    // 聊天切换：退出文游，回到原聊天
    eventSource.on(event_types.CHAT_CHANGED, () => {
        closeTheater();
        _appendedSig = '';
        resetLearned();   // 换聊天了，学到的角色名清空，避免串味
    });

    console.log('[VN-Lite] 文游Lite 已加载：' + settings.get().mode + ' 模式');
}

init();
