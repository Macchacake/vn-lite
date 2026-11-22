// ============================================
// theater.js — 全屏剧场：逐段推进、自动播放、连续回放
// items: [{ script, title }]
// ============================================

import { createStage, stopTyper } from './stage.js';

let _open = null; // 当前剧场实例

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
            <button class="vnl-btn" data-act="auto" title="自动播放">▶</button>
            <button class="vnl-btn" data-act="close" title="关闭">✕</button>
        </div>
        <div class="vnl-stage-slot"></div>
        <div class="vnl-theater-foot">点击画面推进 · Esc 退出</div>`;
    document.body.appendChild(overlay);

    const titleEl = overlay.querySelector('.vnl-theater-title');
    const slot = overlay.querySelector('.vnl-stage-slot');
    const autoBtn = overlay.querySelector('[data-act="auto"]');

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
            slot.innerHTML = '<div style="color:#8d99ad;padding:40px;text-align:center;">剧场结束，点击 ✕ 退出</div>';
            return;
        }
        titleEl.textContent = items[i].title || `第 ${i + 1} 幕`;
        stage = createStage(items[i].script, env);
        slot.appendChild(stage.el);
        stage.next();
    }

    // 自动模式：段落完成（打字结束）后延时推进
    function scheduleAuto() {
        if (!auto || !stage || instance.closed) return;
        clearTimeout(autoTimer);
        const wait = Math.min(6000, 1400 + stage._lastTextLen * S.typeMs * 0.6 || 2000);
        autoTimer = setTimeout(() => {
            if (!auto || !stage) return;
            // 通过模拟点击推进
            stage.el.click();
            scheduleAuto();
        }, wait);
    }

    autoBtn.addEventListener('click', e => {
        e.stopPropagation();
        auto = !auto;
        autoBtn.textContent = auto ? '❚❚' : '▶';
        if (auto) scheduleAuto();
    });

    overlay.querySelector('[data-act="close"]').addEventListener('click', e => {
        e.stopPropagation();
        closeTheater();
    });

    // 点击舞台区推进（自动模式由定时器推进，手动点也允许）
    overlay.addEventListener('click', e => {
        if (e.target.closest('.vnl-theater-head, .vnl-theater-foot')) return;
        // 交给舞台自己的 click 处理；剧场底部提示区不再推进
    });

    function onKey(e) {
        if (e.key === 'Escape') closeTheater();
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
        // 连续剧场：当前幕后加载后续剧本
        chain(scripts, titles) {
            items = items.concat(scripts.map((s, i) => ({ script: s, title: (titles && titles[i]) || `第 ${items.length + i + 1} 幕` })));
        },
    };
    return _open;
}

function closeTheater() {
    if (_open) _open.close();
}

function isOpen() { return !!_open; }

export { openTheater, closeTheater, isOpen };
