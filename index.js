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
    generateQuietPrompt,
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
function currentCharacters() {
    const out = [];
    try {
        if (selected_group) {
            const g = groups.find(x => x.id == selected_group);
            if (g && Array.isArray(g.members)) {
                for (const mid of g.members) {
                    const c = characters[mid];
                    if (c && c.name) out.push(c);
                }
            }
            return out;
        }
    } catch { /* 群组信息不可用时忽略 */ }
    try {
        if (Array.isArray(characters)) for (const c of characters) if (c && c.name) out.push(c);
    } catch { /* 角色列表不可用时忽略 */ }
    return out;
}

// 设置面板用：列出当前聊天里的角色名，方便逐个填英文提示词
function knownChars() {
    return currentCharacters().slice(0, 60).map(c => ({ name: c.name }));
}

function getCtxInfo(extra) {
    const members = currentCharacters().slice(0, 60).map(c => c.name);
    return Object.assign({
        charName: name2,
        userName: name1,
        members,
        chunk: settings.get().chunk || 60,
    }, extra || {});
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

// ---------- 角色外观：吸收 AI 写的 [look:] 标签 ----------
// AI 看过角色卡，它写出来的外观标签比插件瞎猜靠谱得多。
// 用户手动改过的提示词优先级更高，不再被覆盖。
function absorbLooks(script) {
    if (!script || !script.looks) return;
    const S = settings.get();
    if (!S.artPrompts) S.artPrompts = {};
    if (!S.lookAuto) S.lookAuto = {};
    let changed = false;
    for (const [name, tags] of Object.entries(script.looks)) {
        const cur = S.artPrompts[name];
        const autoOwned = S.lookAuto[name] === true;
        if (cur && !autoOwned) continue;      // 用户自己写的，别动
        if (cur === tags) continue;
        S.artPrompts[name] = tags;
        S.lookAuto[name] = true;
        if (S.artCache && S.artCache.char) delete S.artCache.char[name];
        changed = true;
    }
    if (changed) settings.save();
}

// ---------- 让 AI 写角色外观标签 ----------
async function generateLooks() {
    const S = settings.get();
    if (!S.artPrompts) S.artPrompts = {};
    if (!S.lookAuto) S.lookAuto = {};
    const chars = currentCharacters().slice(0, 40);
    if (!chars.length) return { ok: 0, total: 0, reason: '当前没有角色' };
    let ok = 0;
    for (const c of chars) {
        if (S.artPrompts[c.name] && S.lookAuto[c.name] !== true) continue;  // 用户写过的跳过
        const desc = [c.description, c.personality, c.scenario].filter(Boolean).join('\n').slice(0, 1500);
        const q = `你是 Danbooru 标签专家。根据角色设定，写一条用于生成该角色「全身立绘」的英文标签串。

只输出标签本身：英文逗号分隔，一行，不要解释、不要引号、不要编号。
顺序固定：1girl 或 1boy → 发色与发型 → 瞳色 → 体型 → 年龄感 → 服装（颜色+款式）→ 显著特征。
不要写表情、不要写背景、不要写镜头角度、不要写画风词。

角色名：${c.name}
角色设定：
${desc || '（这张卡没有写外观，请按名字给一个合理的日系角色外观）'}`;
        try {
            let out = await generateQuietPrompt(q, true, true);
            out = String(out || '').split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
            out = out.replace(/^["'`]+|["'`]+$/g, '').replace(/^(tags?|标签)[:：]\s*/i, '').trim();
            if (!out) continue;
            if (!/^1(boy|girl|other)\b/i.test(out)) out = '1girl, ' + out;
            S.artPrompts[c.name] = out;
            S.lookAuto[c.name] = true;
            if (S.artCache && S.artCache.char) delete S.artCache.char[c.name];
            ok++;
        } catch (e) {
            console.warn('[VN-Lite] 生成外观标签失败：' + c.name, e && e.message);
        }
    }
    settings.save();
    return { ok, total: chars.length };
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
        knownChars,
        generateLooks,
        sendUserMessage,
        // CG 绘画：先查缓存，再按需生成（URL/开关实时生效）
        sd: (prompt) => art.cg(prompt),
        openTheater: (script) => {
            openTheater([{ script, title: name2 || '演出' }], envFactory);
            startWatcher();
        },
    };
}

// ---------- 渲染调度 ----------
let generating = false;

// ---------- 剧场同层追加（不退出剧场继续剧情） ----------
let _appendedSig = '';

// 找出最后一条 AI 消息（含它的唯一签名）
function lastAiMsg() {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && m.mes && m.mes.trim()) {
            return { msg: m, id: i, sig: i + ':' + (m.swipe_id ?? 0) + ':' + m.mes.length };
        }
    }
    return null;
}

// 返回 true 表示「确实追加了一幕」，false 表示没有新东西
function appendLatestToTheater() {
    const hit = lastAiMsg();
    if (!hit) return false;
    if (hit.sig === _appendedSig) return false; // 同一条消息（流式/重复事件）不重复追加
    _appendedSig = hit.sig;
    const S = settings.get();
    const script = parseMessage(hit.msg.mes, getCtxInfo({ autoChoice: !!S.autoChoice }));
    if (!script || !script.usable) return false;
    absorbLooks(script);
    const added = appendTheater(script, name2 || '演出');
    try { art.prefetch(script); } catch (e) { /* 预生成失败不影响演出 */ }
    return !!added;
}

// 兜底轮询：手机端酒馆的 GENERATION_ENDED / MESSAGE_RECEIVED 偶尔漏发，
// 只要剧场开着就每秒对一次 chat，保证「点了选项一定会往下走」。
let _watchTimer = null;
function startWatcher() {
    if (_watchTimer) return;
    _watchTimer = setInterval(() => {
        if (!isOpen()) { stopWatcher(); return; }
        try { appendLatestToTheater(); } catch (e) { /* 忽略单次异常 */ }
    }, 1000);
}
function stopWatcher() {
    if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
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
    const S = settings.get();
    for (let k = 0; k < recent.length; k++) {
        // 只有最后一幕补兜底行动项，历史幕保持原样
        const last = k === recent.length - 1;
        const script = parseMessage(chat[recent[k]].mes, getCtxInfo({ autoChoice: last && !!S.autoChoice }));
        if (script && script.usable) { absorbLooks(script); items.push({ script, title: name2 || '演出' }); }
    }
    return items;
}

function enterVnMode() {
    if (isOpen()) return;
    const items = buildTheaterItems();
    // 进剧场时最后一条已经在 items 里演过了，先记下签名，避免兜底轮询又追加一遍
    const hit = lastAiMsg();
    _appendedSig = hit ? hit.sig : '';
    openTheater(items, envFactory, { startAtEnd: true });
    startWatcher();
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
        stopWatcher();
        _appendedSig = '';
        resetLearned();   // 换聊天了，学到的角色名清空，避免串味
    });

    console.log('[VN-Lite] 文游Lite 已加载：' + settings.get().mode + ' 模式');
}

init();
