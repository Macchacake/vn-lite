// ============================================
// theater.js — 全屏剧场 + 游戏菜单系统
// 顶栏大按钮：☰菜单 / ▶自动 / ⏭快进 / ✕退出
// 菜单面板：继续、重播、快进、字号±、音乐、退出
// 全部为 44px+ 大触控目标，适配手机。
// items: [{ script, title }]
// ============================================

import { createStage, stopTyper } from './stage.js';
import { save as saveSettings, mountPanel } from './settings.js';
import { bgm } from './bgm.js';

let _open = null; // 当前剧场实例

function applyFont(px) {
    document.documentElement.style.setProperty('--vnl-fs', px + 'px');
}

function openTheater(items, envFactory, opts = {}) {
    if (!Array.isArray(items)) items = [];
    closeTheater(); // 防重入

    const env = Object.assign({}, envFactory(), { openTheater: null, allowTheater: false });
    const S = env.settings;

    const overlay = document.createElement('div');
    overlay.className = 'vnl-theater';
    overlay.innerHTML = `
        <div class="vnl-theater-head">
            <div class="vnl-theater-title"></div>
            <button class="vnl-btn" data-act="menu" title="菜单">☰</button>
            <button class="vnl-btn" data-act="auto" title="自动播放">▶</button>
            <button class="vnl-btn" data-act="ff" title="快进到结尾">⏭</button>
            <button class="vnl-btn" data-act="close" title="退出剧场">✕</button>
        </div>
        <div class="vnl-stage-slot"></div>`;
    document.body.appendChild(overlay);

    const titleEl = overlay.querySelector('.vnl-theater-title');
    const slot = overlay.querySelector('.vnl-stage-slot');
    const autoBtn = overlay.querySelector('[data-act="auto"]');

    // ---------- 新幕提示角标 ----------
    const badge = document.createElement('div');
    badge.className = 'vnl-newflash';
    badge.textContent = '＋ 新的一幕';
    overlay.appendChild(badge);
    let badgeTimer = null;
    function flashNew() {
        badge.classList.add('vnl-newflash-on');
        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => badge.classList.remove('vnl-newflash-on'), 2600);
    }

    // ---------- 游戏菜单面板 ----------
    const menu = document.createElement('div');
    menu.className = 'vnl-menu';
    menu.innerHTML = `
        <div class="vnl-menu-panel">
            <div class="vnl-menu-title">— 演出菜单 —</div>
            <button class="vnl-menu-btn" data-m="resume">▶ 继续演出</button>
            <button class="vnl-menu-btn" data-m="replay">↻ 重播本幕</button>
            <button class="vnl-menu-btn" data-m="ff">⏭ 快进到本幕结尾</button>
            <div class="vnl-menu-row">
                <button class="vnl-menu-btn vnl-menu-half" data-m="fsmall">A− 缩小</button>
                <button class="vnl-menu-btn vnl-menu-half" data-m="fbig">A+ 放大</button>
            </div>
            <button class="vnl-menu-btn" data-m="bgm">♪ 氛围音乐</button>
            <button class="vnl-menu-btn" data-m="settings">⚙ 文游设置</button>
            <button class="vnl-menu-btn vnl-menu-danger" data-m="exit">✕ 退出文游</button>
        </div>`;
    overlay.appendChild(menu);

    // ---------- 文游设置页（所有设置都在这里） ----------
    const settingsPage = document.createElement('div');
    settingsPage.className = 'vnl-settings';
    settingsPage.innerHTML = `
        <div class="vnl-settings-head">
            <button class="vnl-btn" data-act="back" title="返回">←</button>
            <div class="vnl-settings-title">文游设置</div>
            <div class="vnl-settings-spacer"></div>
        </div>
        <div class="vnl-settings-body"></div>`;
    overlay.appendChild(settingsPage);

    const settingsBody = settingsPage.querySelector('.vnl-settings-body');
    let settingsMounted = false;

    function showSettings() {
        if (!settingsMounted) {
            mountPanel(settingsBody);
            settingsMounted = true;
        }
        settingsPage.classList.add('vnl-settings-on');
    }
    function hideSettings() {
        settingsPage.classList.remove('vnl-settings-on');
    }
    settingsPage.querySelector('[data-act="back"]').addEventListener('click', e => {
        e.stopPropagation();
        hideSettings();
    });

    const menuOpen = () => menu.classList.contains('vnl-menu-on');
    const showMenu = () => { refreshMenu(); menu.classList.add('vnl-menu-on'); };
    const hideMenu = () => menu.classList.remove('vnl-menu-on');

    function refreshMenu() {
        menu.querySelector('[data-m="bgm"]').textContent = '♪ 氛围音乐：' + (S.bgmOn ? '开' : '关');
        autoBtn.textContent = auto ? '❚❚' : '▶';
    }

    let idx = 0;
    let stage = null;
    let auto = false;
    let autoTimer = null;
    let atEndBox = false;
    const instance = { closed: false };

    // 当前幕自然演完 → 若后面还有排队的新幕，自动衔接
    function handleStageEnd() {
        if (instance.closed) return;
        if (auto) return; // 自动模式由 scheduleAuto 统一推进
        if (idx + 1 < items.length) {
            setTimeout(() => {
                if (!instance.closed && stage && stage._ended) load(idx + 1);
            }, 900);
        }
    }

    function load(i) {
        clearTimeout(autoTimer);
        if (stage) { stage.dispose(); stage = null; }
        idx = i;
        if (i >= items.length) {
            atEndBox = true;
            titleEl.textContent = '—— 全部演完 ——';
            stage = null;
            const box = document.createElement('div');
            box.className = 'vnl-theater-endbox';
            box.innerHTML = items.length
                ? '<div class="vnl-theater-endtext">等待新的剧情…</div>'
                : '<div class="vnl-theater-endtext">还没有可以演出的剧情。<br>先回到酒馆发一条消息，再点魔棒进来。</div>';
            const again = document.createElement('button');
            again.className = 'vnl-menu-btn';
            again.textContent = '↻ 从头再看';
            again.addEventListener('click', e => { e.stopPropagation(); load(0); });
            const exit = document.createElement('button');
            exit.className = 'vnl-menu-btn vnl-menu-danger';
            exit.textContent = '✕ 退出文游';
            exit.addEventListener('click', e => { e.stopPropagation(); closeTheater(); });
            box.append(again, exit);
            slot.innerHTML = '';
            slot.appendChild(box);
            return;
        }
        atEndBox = false;
        titleEl.textContent = items[i].title || `第 ${i + 1} 幕`;
        const stageEnv = Object.assign({}, env, { onEnd: handleStageEnd });
        stage = createStage(items[i].script, stageEnv);
        slot.appendChild(stage.el);
        stage.next();
        if (auto) scheduleAuto();
    }

    // ---------- 同层追加新幕（不退出剧场继续剧情） ----------
    function append(script, title) {
        if (instance.closed || !script) return false;
        items.push({ script, title });
        const wasOver = atEndBox || (stage && stage._ended);
        flashNew();
        // 当前一幕已演完/处于结尾 → 自动进入新幕；否则看完当前幕后自然衔接
        if (wasOver) load(atEndBox ? items.length - 1 : idx + 1);
        return true;
    }

    // 自动模式：段落完成（打字结束）后延时推进
    function scheduleAuto() {
        if (!auto || !stage || instance.closed) return;
        clearTimeout(autoTimer);
        const wait = Math.min(6000, 1400 + stage._lastTextLen * S.typeMs * 0.6 || 2000);
        autoTimer = setTimeout(() => {
            if (!auto || instance.closed) return;
            if (!stage) return;
            if (stage._ended) { load(idx + 1); return; } // 本幕演完 → 下一幕
            stage.el.click();
            scheduleAuto();
        }, wait);
    }

    // ---------- 顶栏按钮 ----------
    overlay.querySelector('[data-act="menu"]').addEventListener('click', e => {
        e.stopPropagation();
        menuOpen() ? hideMenu() : showMenu();
    });
    autoBtn.addEventListener('click', e => {
        e.stopPropagation();
        auto = !auto;
        refreshMenu();
        if (auto) scheduleAuto();
    });
    overlay.querySelector('[data-act="ff"]').addEventListener('click', e => {
        e.stopPropagation();
        hideMenu();
        if (stage) stage.jumpToEnd();
    });
    overlay.querySelector('[data-act="close"]').addEventListener('click', e => {
        e.stopPropagation();
        closeTheater();
    });

    // ---------- 菜单按钮（大按钮，全部可点） ----------
    menu.addEventListener('click', e => {
        e.stopPropagation();
        const btn = e.target.closest('.vnl-menu-btn');
        if (!btn) { hideMenu(); return; } // 点遮罩空白处 = 继续
        const act = btn.dataset.m;
        if (act === 'resume') {
            hideMenu();
        } else if (act === 'replay') {
            hideMenu();
            if (stage) stage.restart();
        } else if (act === 'ff') {
            hideMenu();
            if (stage) stage.jumpToEnd();
        } else if (act === 'fsmall' || act === 'fbig') {
            S.fontSize = Math.max(12, Math.min(22, S.fontSize + (act === 'fbig' ? 1 : -1)));
            applyFont(S.fontSize);
            saveSettings();
        } else if (act === 'bgm') {
            S.bgmOn = !S.bgmOn;
            bgm.setEnabled(S.bgmOn);
            saveSettings();
            refreshMenu();
        } else if (act === 'settings') {
            hideMenu();
            showSettings();
        } else if (act === 'exit') {
            closeTheater();
        }
    });

    // ---------- 键盘（桌面端补充） ----------
    function onKey(e) {
        if (e.key === 'Escape') {
            if (settingsPage.classList.contains('vnl-settings-on')) hideSettings();
            else if (menuOpen()) hideMenu();
            else closeTheater();
        }
        if (e.key === 'ArrowRight' && stage) stage.next();
    }
    document.addEventListener('keydown', onKey);

    // 从魔棒进入时直接看最新一幕；从舞台按钮进入时只有一幕，行为不变
    const start = opts.startAtEnd === false ? 0 : Math.max(0, items.length - 1);
    load(start);
    _open = {
        items,
        append,
        close() {
            instance.closed = true;
            clearTimeout(autoTimer);
            clearTimeout(badgeTimer);
            document.removeEventListener('keydown', onKey);
            stopTyper();
            if (stage) stage.dispose();
            overlay.remove();
            _open = null;
        },
    };
    return _open;
}

function closeTheater() {
    if (_open) _open.close();
}

function isOpen() { return !!_open; }

// 剧场开着 → 追加新幕；剧场没开 → 返回 false（调用方走常规挂载）
function appendTheater(script, title) {
    if (!_open || _open.closed) return false;
    return _open.append(script, title);
}

export { openTheater, closeTheater, isOpen, appendTheater };
