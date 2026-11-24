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
import { parseMessage } from './src/parser.js';
import { openTheater, closeTheater, appendTheater, isOpen } from './src/theater.js';
import { generateCG } from './src/sd.js';
import { bgm } from './src/bgm.js';
import { SCENE_DEFS, EXPR_LIST } from './src/assets.js';

const PROTOCOL_KEY = 'vnLiteProtocol';

// ---------- 协议提示词（注入给 AI 的演出规范） ----------
const SCENE_NAMES = Object.keys(SCENE_DEFS).join('、');
const PROTOCOL_TEXT =
    '【文字冒险游戏演出规范】\n' +
    '你是一场文字冒险游戏的主持人（Game Master），你的回复会被渲染成视觉小说游戏画面。请严格遵守：\n' +
    '一、演出标签：\n' +
    '1. 场景切换时，单独一行写 [scene:场景]。场景只能是这些类目之一：' + SCENE_NAMES + '\n' +
    '2. 角色登场或开始说话时，单独一行写 [char:角色名|表情]。表情只能是：' + EXPR_LIST.join('、') + '\n' +
    '3. 氛围明显变化时，单独一行写 [bgm:氛围]。氛围只能是：平静、欢快、紧张、悲伤、温馨、神秘\n' +
    '4. 剧情需要玩家做选择时，单独一行写 [choice:选项A|选项B|选项C]（2~4个选项），写完就停，等待玩家选择\n' +
    '5. 需要紧张刺激的瞬间，单独一行写 [qte:简短描述]\n' +
    '6. 重要剧情节点（初遇、转折、告白、高潮等值得立绘演出的瞬间），单独一行写 [cg:english prompt]，内容为一句英文绘图提示词，按「人数与性别 → 人物外观与服装 → 动作表情 → 场景与光照」顺序用逗号短语描述，例如 [cg:1girl, silver hair, white dress, standing on beach at sunset, emotional, dramatic lighting]\n' +
    '二、游戏系统标签（像 RPG 游戏一样主动运用它们）:\n' +
    '7. 玩家状态变化时，单独一行写 [stats:HP|80/100|MP|30/50|金币|120]（标签与数值用|交替排列，分数值会显示为血条）\n' +
    '8. 玩家获得或失去物品时，单独一行写 [item:+物品名x2] 或 [item:-物品名]\n' +
    '9. 任务开始、完成或失败时，单独一行写 [quest:开始|任务名|简短描述]、[quest:完成|任务名] 或 [quest:失败|任务名]\n' +
    '10. 角色对玩家好感度明显变化时，单独一行写 [aff:角色名|+2]（或 -2）\n' +
    '11. 玩家行动成败存在悬念时（战斗、攀爬、说服、探索…），单独一行写 [dice:1d20|15|成功后的剧情|失败后的剧情]，写完就停，等待玩家掷骰\n' +
    '12. 剧情走向应交给玩家决定时，单独一行写 [input:提示语]，写完就停，等待玩家输入\n' +
    '三、主持人守则：\n' +
    '13. 对话使用「」，叙述正常书写；标签独占一行，不要放进引号内\n' +
    '14. 除以上标签外不要输出任何其他标签、HTML 或代码块，不要输出思考过程\n' +
    '15. 像真正的文字游戏一样推进：战斗与探索用 [dice:] 判定，奖励用 [item:]，剧情进展用 [quest:]，情感变化用 [aff:]，状态变化用 [stats:]，重要画面用 [cg:]。不要每条都堆满标签，在剧情自然的节点使用。';

function applyProtocolInjection() {
    const S = settings.get();
    const on = S.enabled && S.mode === 'protocol';
    try {
        setExtensionPrompt(PROTOCOL_KEY, on ? PROTOCOL_TEXT : '', 0, 0, false);
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
    return { charName: name2, userName: name1, members };
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
        // CG 绘画：每次调用取最新设置（URL/开关实时生效）
        sd: (prompt) => generateCG(prompt, settings.get()),
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
    if (script && script.usable) appendTheater(script, name2 || '演出');
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

function waitForWandButton() {
    const wand = document.getElementById('extensionsMenuButton');
    if (wand && !wand.dataset.vnlBound) {
        wand.dataset.vnlBound = '1';
        wand.addEventListener('click', () => setTimeout(installWandButton, 60));
    }
    if (installWandButton()) return;
    let tries = 0;
    const timer = setInterval(() => {
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
    });

    console.log('[VN-Lite] 文游Lite 已加载：' + settings.get().mode + ' 模式');
}

init();
