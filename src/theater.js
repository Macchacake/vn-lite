// ============================================
// theater.js — 全屏剧场 + 游戏菜单系统
// 顶栏大按钮：☰菜单 / ▶自动 / ⏭快进 / ✕退出
// 菜单面板：继续、重播、快进、字号±、音乐、退出
// 全部为 44px+ 大触控目标，适配手机。
// items: [{ script, title }]
// ============================================

import { createStage, stopTyper } from './stage.js';
import { save as saveSettings } from './settings.js';
import { bgm } from './bgm.js';

let _open = null; // 当前剧场实例

function applyFont(px) {
    document.documentElement.style.setProperty('--vnl-fs', px + 'px');
}

function openTheater(items, envFactory) {
    if (!items || !items.length) return;
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
            <button class="vnl-menu-btn vnl-menu-danger" data-m="exit">✕ 退出剧场</button>
        </div>`;
    overlay.appendChild(menu);

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
    const instance = { closed: false };

    function load(i) {
        clearTimeout(autoTimer);
        if (stage) { stage.dispose(); stage = null; }
        idx = i;
        if (i >= items.length) {
            titleEl.textContent = '—— 全部演完 ——';
            stage = null;
            const box = document.createElement('div');
            box.className = 'vnl-theater-endbox';
            box.innerHTML = '<div class="vnl-theater-endtext">剧 场 结 束</div>';
            const again = document.createElement('button');
            again.className = 'vnl-menu-btn';
            again.textContent = '↻ 从头再看';
            again.addEventListener('click', e => { e.stopPropagation(); load(0); });
            const exit = document.createElement('button');
            exit.className = 'vnl-menu-btn vnl-menu-danger';
            exit.textContent = '✕ 退出剧场';
            exit.addEventListener('click', e => { e.stopPropagation(); closeTheater(); });
            box.append(again, exit);
            slot.innerHTML = '';
            slot.appendChild(box);
            return;
        }
        titleEl.textContent = items[i].title || `第 ${i + 1} 幕`;
        stage = createStage(items[i].script, env);
        slot.appendChild(stage.el);
        stage.next();
        if (auto) scheduleAuto();
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
        } else if (act === 'exit') {
            closeTheater();
        }
    });

    // ---------- 键盘（桌面端补充） ----------
    function onKey(e) {
        if (e.key === 'Escape') { menuOpen() ? hideMenu() : closeTheater(); }
        if (e.key === 'ArrowRight' && stage) stage.next();
    }
    document.addEventListener('keydown', onKey);

    load(0);
    _open = {
        close() {
            instance.closed = true;
            clearTimeout(autoTimer);
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

export { openTheater, closeTheater, isOpen };
