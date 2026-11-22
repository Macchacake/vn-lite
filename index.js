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
import { bindEnvFactory, renderAll, mountOne } from './src/stage.js';
import { openTheater, closeTheater } from './src/theater.js';
import { bgm } from './src/bgm.js';
import { SCENE_DEFS, EXPR_LIST } from './src/assets.js';

const PROTOCOL_KEY = 'vnLiteProtocol';

// ---------- 协议提示词（注入给 AI 的演出规范） ----------
const SCENE_NAMES = Object.keys(SCENE_DEFS).join('、');
const PROTOCOL_TEXT =
    '【视觉小说演出规范】\n' +
    '你输出的回复会被渲染为视觉小说画面。请严格遵守：\n' +
    '1. 场景切换时，单独一行写 [scene:场景]。场景只能是这些类目之一：' + SCENE_NAMES + '\n' +
    '2. 角色登场或开始说话时，单独一行写 [char:角色名|表情]。表情只能是：' + EXPR_LIST.join('、') + '\n' +
    '3. 氛围明显变化时，单独一行写 [bgm:氛围]。氛围只能是：平静、欢快、紧张、悲伤、温馨、神秘\n' +
    '4. 剧情需要玩家做选择时，单独一行写 [choice:选项A|选项B|选项C]（2~4个选项），写完就停，等待玩家选择\n' +
    '5. 需要紧张刺激的瞬间，单独一行写 [qte:简短描述]\n' +
    '6. 标签独占一行，不要放进引号内；正文照常写对话与叙述，对话使用「」\n' +
    '7. 除以上标签外，不要输出任何其他标签、HTML 或代码块';

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
        openTheater: (script) => {
            openTheater([{ script, title: name2 || '演出' }], envFactory);
        },
    };
}

// ---------- 渲染调度 ----------
let generating = false;

function safeRenderAll(autoplayLast = true) {
    try { renderAll(chat, { autoplayLast }); } catch (e) { console.warn('[VN-Lite] 渲染失败', e); }
}

function safeMountOne(id, autoplay = false) {
    try { mountOne(chat, id, { autoplay }); } catch (e) { console.warn('[VN-Lite] 挂载失败', e); }
}

// ---------- 启动 ----------
async function init() {
    settings.init(extension_settings, saveSettingsDebounced, {
        onChanged: (S) => {
            applyProtocolInjection();
            bgm.setEnabled(S.bgmOn);
            safeRenderAll(false);
        },
    });
    bindEnvFactory(envFactory);

    // BGM 初始状态 + 解锁
    bgm.setEnabled(settings.get().bgmOn);
    bgm.setVolume(settings.get().bgmVol);
    bgm.attachUnlock();
    document.getElementById('vnl-bgmon')?.addEventListener('change', e => {
        bgm.setEnabled(e.target.checked);
    });
    document.getElementById('vnl-bgmvol')?.addEventListener('input', e => {
        bgm.setVolume(Number(e.target.value) / 100);
    });

    // 协议注入（扩展加载即生效）
    applyProtocolInjection();

    // 生成中标记：生成期间不渲染新舞台（流式输出期间显示原文）
    eventSource.on(event_types.GENERATION_STARTED, () => { generating = true; });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        generating = false;
        setTimeout(() => safeRenderAll(true), 400);
    });

    // 新消息（非流式 / 首条消息）
    eventSource.on(event_types.MESSAGE_RECEIVED, (id) => {
        if (generating) return; // 流式结束时由 GENERATION_ENDED 处理
        setTimeout(() => safeMountOne(Number(id), true), 300);
    });

    // 消息编辑 / 滑动分支（swipe）
    eventSource.on(event_types.MESSAGE_UPDATED, (id) => {
        setTimeout(() => safeMountOne(Number(id), false), 300);
    });

    // 聊天切换：重挂最近消息（旧消息静态展示，最新一条自动演出）
    eventSource.on(event_types.CHAT_CHANGED, () => {
        closeTheater();
        setTimeout(() => safeRenderAll(true), 700);
    });

    // 初始渲染（扩展加载时聊天已就绪的情况）
    setTimeout(() => safeRenderAll(true), 800);

    console.log('[VN-Lite] 文游Lite 已加载：' + settings.get().mode + ' 模式');
}

init();
