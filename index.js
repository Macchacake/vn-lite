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
// 命名空间导入：即使某些酒馆版本没有导出 sendTextareaMessage 也不会让整个插件加载失败
import * as ST from '../../../../script.js';
import { extension_settings } from '../../../../scripts/extensions.js';
import { groups, selected_group } from '../../../../scripts/group-chats.js';

import * as settings from './src/settings.js';
import * as art from './src/art.js';
import * as gallery from './src/gallery.js';
import * as session from './src/session.js';
import * as memory from './src/memory.js';
import { parseMessage, resetLearned } from './src/parser.js';
import * as looks from './src/looks.js';
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

function getCtxInfo(extra) {
    const members = currentCharacters().slice(0, 60).map(c => c.name);
    return Object.assign({
        charName: name2,
        userName: name1,
        members,
        chunk: settings.get().chunk || 60,
    }, extra || {});
}

// ---------- 当前对话标识（本地图片按对话隔离用） ----------
// getCurrentChatDetails().sessionName 是酒馆为每段聊天分配的稳定文件名，
// 同一角色新建聊天会换名，群聊用 chat_id。拿不到时退回角色名，保证不串台。
function syncChatKey() {
    let key = '';
    try {
        const d = typeof ST.getCurrentChatDetails === 'function' ? ST.getCurrentChatDetails() : null;
        if (d && d.sessionName) key = d.sessionName;
    } catch (e) { /* 版本差异：忽略 */ }
    if (!key) key = (String(name2 || '') || 'chat') + '::' + String(name1 || '');
    session.setChatKey(key);
    // 切换/初始化后，把这段对话已存到手机的图重建出来
    try { art.hydrateChat(); } catch (e) { /* 本地存储不可用不影响演出 */ }
    return key;
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

// ---------- 角色外观：自动从剧情人设 / 柏宝书读取 ----------
// 设置页不再提供手填入口，也不再让 LLM 现编外观。
// 优先级靠「谁先写进来」保证：
//   柏宝书（memory.js 同步，lookSource=memory）
//   > 剧情里已有的 [look:] 标签（老存档兼容）
//   > 角色卡人设 description/personality/scenario/first_mes
//   > 当前聊天文本里提到该角色时的外貌描写
function absorbLooks(script) {
    if (!script || !script.looks) return;
    const S = settings.get();
    if (!S.artPrompts) S.artPrompts = {};
    if (!S.lookAuto) S.lookAuto = {};
    if (!S.lookSource) S.lookSource = {};
    let changed = false;
    for (const [name, tags] of Object.entries(script.looks)) {
        const cur = S.artPrompts[name];
        const autoOwned = S.lookAuto[name] === true || S.lookSource[name] === 'memory' || S.lookSource[name] === 'auto';
        if (cur && !autoOwned) continue;
        if (cur === tags) continue;
        S.artPrompts[name] = tags;
        S.lookAuto[name] = true;
        S.lookSource[name] = 'auto';
        if (S.artCache && S.artCache.char) delete S.artCache.char[name];
        changed = true;
    }
    if (changed) settings.save();
}

// 角色卡没写长相时，从最近聊天里「提到该角色名」的上下文抽外貌词。
function storyLooks(name) {
    if (!name) return null;
    const parts = [];
    try {
        const msgs = (typeof chat !== 'undefined' && Array.isArray(chat)) ? chat.slice(-14) : [];
        for (const m of msgs) {
            const t = String((m && m.mes) || '');
            let idx = 0, guard = 0;
            while ((idx = t.indexOf(name, idx)) >= 0 && guard++ < 3) {
                parts.push(t.slice(Math.max(0, idx - 60), idx + 240));
                idx += name.length;
            }
        }
    } catch (e) { /* chat 不可用就跳过 */ }
    const text = parts.join('\n').slice(0, 2000);
    return text ? looks.looksFromCard({ description: text }) : null;
}

// 同步补齐：不等 LLM，进入文游 / 追加新幕的当下就能用。
function autoFillLooks(names) {
    const S = settings.get();
    if (!S.artPrompts) S.artPrompts = {};
    if (!S.lookAuto) S.lookAuto = {};
    if (!S.lookSource) S.lookSource = {};
    const cards = currentCharacters().slice(0, 40);
    const want = [...new Set([...(names || []), ...cards.map(c => c.name)])].filter(Boolean);
    let ok = 0;
    for (const name of want) {
        if (S.artPrompts[name]) continue;   // 柏宝书 / 剧情标签 / 已有值都不覆盖
        const card = cards.find(c => c.name === name) || { name };
        const tags = looks.looksFromCard(card) || storyLooks(name);
        if (!tags) continue;                // 没有任何外貌线索 → 不画随机立绘
        S.artPrompts[name] = tags;
        S.lookAuto[name] = true;
        S.lookSource[name] = 'auto';
        if (S.artCache && S.artCache.char) delete S.artCache.char[name];
        ok++;
    }
    if (ok) settings.save();
    return { ok, total: want.length };
}

// 外观补齐入口：同步跑完立刻重新预生成，保证当前这一幕就能出立绘。
function ensureLooks(names, scripts = []) {
    const S = settings.get();
    if (!(S.enabled && S.sdOn && S.autoArt)) return;
    const r = autoFillLooks(names);
    if (!r.ok) return;
    for (const s of scripts) {
        try { art.prefetch(s); } catch (e) { /* 失败不影响演出 */ }
    }
}

// 从剧本里收集需要立绘的角色名
function scriptCharNames(script) {
    const out = [];
    for (const seg of script?.segments || []) {
        if ((seg.t === 'say' || seg.t === 'inner') && seg.who) out.push(seg.who);
        if (seg.t === 'dir' && seg.char?.name) out.push(seg.char.name);
    }
    return out;
}

// ---------- 发送玩家选择 ----------
// 关键：真正发起 AI 请求要走酒馆导出的 sendTextareaMessage()，
// 它内部会调用 Generate()（读输入框内容 → 发 API 请求 → 出消息）。
// 之前只模拟点 #send_but，在部分手机酒馆版本上按钮 id 不同 / 被遮挡 / 事件没绑上，
// 结果选项点了没反应、也不发请求。这里优先直接调函数，模拟点按钮只作为兜底。
let _sending = false;
// 返回 true 表示「确实发起了一次发送」，false 表示被连点保护挡下 / 无发送入口。
// minigame.js 二次确认后据此决定是否翻页，避免锁冲突时把玩家的行动静默吞掉。
function sendUserMessage(text) {
    const ta = document.querySelector('#send_textarea');
    if (!ta) return false;
    if (_sending) return false;        // 连点保护：一次选择只发一条
    _sending = true;
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    let sent = false;
    try {
        const sendFn = ST.sendTextareaMessage;
        if (typeof sendFn === 'function') {
            // 先标记已发送再调用：sendFn 内部可能「请求已发出、后续处理才抛错」，
            // 若此时回退到 btn.click() 会造成同一次选择发两条 AI 请求。
            sent = true;
            const r = sendFn();            // 内部 await Generate()，真正发 AI 请求
            if (r && typeof r.catch === 'function') r.catch(e => console.warn('[VN-Lite] AI 请求失败', e));
        }
    } catch (e) {
        console.warn('[VN-Lite] sendTextareaMessage 调用异常', e);
    }
    if (!sent) {
        const btn = document.querySelector('#sendbut') || document.querySelector('#send_but');
        if (btn) btn.click();
        else { console.warn('[VN-Lite] 找不到发送按钮'); _sending = false; return false; }
    }
    // 生成结束后由 GENERATION_ENDED 复位；这里留一个较长兜底，防止异常卡死
    setTimeout(() => { _sending = false; }, 30000);
    return true;
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
            startWatcher();
        },
    };
}

// ---------- 渲染调度 ----------
let generating = false;

// ---------- 剧场同层追加（不退出剧场继续剧情） ----------
let _appendedKey = '';   // 已追加过的消息稳定 key（索引+swipe），用于去重

// 找出最后一条 AI 消息：
// - key：稳定标识（消息索引 + swipe_id），流式期间不变，用于「是否已追加」去重
// - fingerprint：含内容长度，流式逐字增长时每次都变，用于判断生成是否已结束
function lastAiMsg() {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && m.mes && m.mes.trim()) {
            const stem = i + ':' + (m.swipe_id ?? 0);
            return { msg: m, id: i, key: stem, fingerprint: stem + ':' + m.mes.length };
        }
    }
    return null;
}

// 返回 true 表示「确实追加了一幕」，false 表示没有新东西
function appendLatestToTheater() {
    const hit = lastAiMsg();
    if (!hit) return false;
    if (hit.key === _appendedKey) return false; // 同一条消息（流式/重复事件）不重复追加
    _appendedKey = hit.key;
    const S = settings.get();
    const script = parseMessage(hit.msg.mes, getCtxInfo({ autoChoice: !!S.autoChoice }));
    if (!script || !script.usable) return false;
    absorbLooks(script);
    const added = appendTheater(script, name2 || '演出');
    ensureLooks(scriptCharNames(script), [script]);
    try { art.prefetch(script); } catch (e) { /* 预生成失败不影响演出 */ }
    return !!added;
}

// 兜底轮询：手机端酒馆的 GENERATION_ENDED / MESSAGE_RECEIVED 偶尔漏发，
// 只要剧场开着就每秒对一次 chat，保证「点了选项一定会往下走」。
// 关键：只在「消息内容连续两次轮询都没变」时才当成一条完整回复追加，
// 否则流式生成时每增长一个字就 fingerprint 变化，会把同一条半截消息
// 反复追加成多幕。这样也不依赖事件是否漏发。
let _watchTimer = null;
let _watchFp = '';
function startWatcher() {
    if (_watchTimer) return;
    _watchFp = '';
    _watchTimer = setInterval(() => {
        if (!isOpen()) { stopWatcher(); return; }
        try {
            const hit = lastAiMsg();
            if (!hit) return;
            if (hit.fingerprint !== _watchFp) { _watchFp = hit.fingerprint; return; } // 还在生成，等下一次
            appendLatestToTheater();
        } catch (e) { /* 忽略单次异常 */ }
    }, 1000);
}
function stopWatcher() {
    if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
    _watchFp = '';
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
    const names = [];
    for (const it of items) names.push(...scriptCharNames(it.script));
    ensureLooks(names, items.map(it => it.script));
    return items;
}

function enterVnMode() {
    if (isOpen()) return;
    const items = buildTheaterItems();
    // 进剧场时最后一条已经在 items 里演过了，先记下签名，避免兜底轮询又追加一遍
    const hit = lastAiMsg();
    _appendedKey = hit ? hit.key : '';
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
    // 绑定当前对话（本地图片按对话隔离）；图集/缓存都从这里取 scope
    syncChatKey();

    // 记忆插件联动（柏宝书等）：把人物外貌/地点描述自动灌进立绘/背景提示词。
    // 把当前用户名写进设置，供主角(memory 里没有 name 字段)对应立绘。
    if (name1 && !settings.get().userName) settings.get().userName = name1;
    memory.init(settings.get(), saveSettingsDebounced, {
        onChanged: () => {
            // 记忆更新可能改了外观提示词 → 让舞台重新取图
            try { art.hydrateChat(); } catch (e) { /* 忽略 */ }
            if (isOpen()) {
                // 已打开剧场时，重新渲染当前聊天让新提示词生效
                try { document.querySelectorAll('.vnl-stage').forEach(s => s.__vnlReRender && s.__vnlReRender()); } catch (e) { /* 忽略 */ }
            }
        },
    });

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
        _sending = false;   // 一次请求结束，解除连点保护
        setTimeout(() => appendLatestToTheater(), 400);
    });
    // 生成失败/中断也要解锁，否则下一次选择发不出去
    eventSource.on(event_types.GENERATION_STOPPED, () => { _sending = false; });
    eventSource.on(event_types.CHAT_CHANGED, () => { _sending = false; });

    // 新消息（非流式 / 首条消息）
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        _sending = false;       // 收到消息说明这次发送已完成
        if (generating) return; // 流式结束时由 GENERATION_ENDED 处理
        setTimeout(() => appendLatestToTheater(), 300);
    });

    // 聊天切换：退出文游，回到原聊天
    eventSource.on(event_types.CHAT_CHANGED, () => {
        closeTheater();
        stopWatcher();
        _appendedKey = '';
        resetLearned();      // 换聊天了，学到的角色名清空，避免串味
        syncChatKey();       // 换对话 → 切到这段对话自己的本地图集/缓存
    });

    console.log('[VN-Lite] 文游Lite 已加载：' + settings.get().mode + ' 模式');
}

init();
