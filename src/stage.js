// ============================================
// stage.js — VN 舞台渲染器
// createStage(): 单条消息的演出舞台（背景交叉淡出、立绘、
// 对话框、打字机、选项/QTE、结束行）
// mountOne()/renderAll(): 挂载到消息 DOM
// 性能：同屏仅一个打字机；旧消息静态渲染；CSS 过渡。
// ============================================

import { sceneBG, weatherOf, silhouetteURI } from './assets.js';
import { parseMessage } from './parser.js';
import { bgm } from './bgm.js';
import { renderChoices, renderQTE } from './minigame.js';

// ---------- 全局唯一打字机 ----------
let _typer = null; // { stop() }
function startTyper(el, text, msPerChar, onDone) {
    stopTyper();
    let i = 0;
    el.textContent = '';
    const cur = document.createElement('span');
    cur.className = 'vnl-cur';
    el.appendChild(cur);
    const timer = setInterval(() => {
        i += msPerChar <= 12 ? 2 : 1;
        if (i >= text.length) { finish(); return; }
        cur.insertAdjacentText('beforebegin', text.slice(i - (msPerChar <= 12 ? 2 : 1), i));
    }, msPerChar);
    function finish() {
        clearInterval(timer);
        el.textContent = text;
        _typer = null;
        onDone && onDone();
    }
    _typer = { finish, stop: () => { clearInterval(timer); _typer = null; } };
    return _typer;
}
function stopTyper() { if (_typer) _typer.stop(); }
function finishTyper() { if (_typer) _typer.finish(); }
function typerActive() { return !!_typer; }

// ---------- 舞台 ----------
// script: parseMessage 输出
// env: { settings, userName, resolveChar(name)->url|null, openTheater(script), sendUserMessage(text) }
function createStage(script, env) {
    const S = env.settings;
    const segs = script.segments;
    const el = document.createElement('div');
    el.className = 'vnl-stage';
    el.style.setProperty('--vnl-fs', S.fontSize + 'px');

    // 背景双层交叉淡出
    const bgA = document.createElement('div'); bgA.className = 'vnl-bg';
    const bgB = document.createElement('div'); bgB.className = 'vnl-bg'; bgB.style.opacity = '0';
    el.append(bgA, bgB);
    let bgFront = bgA, bgBack = bgB;

    const weather = document.createElement('div'); weather.className = 'vnl-weather';
    const sprites = document.createElement('div'); sprites.className = 'vnl-sprites';
    const dialog = document.createElement('div'); dialog.className = 'vnl-dialog';
    dialog.innerHTML = '<div class="vnl-name" style="display:none"></div><div class="vnl-text"></div>';
    const nameEl = dialog.querySelector('.vnl-name');
    const textEl = dialog.querySelector('.vnl-text');
    const ctrl = document.createElement('div'); ctrl.className = 'vnl-ctrl';
    el.append(weather, sprites, dialog, ctrl);

    const state = {
        ptr: -1,          // 已处理的 segment 下标
        onStage: new Map(), // name -> {expr, node}
        interactive: false, // choice/qte 等待中，点击不推进
        ended: false,
        disposed: false,
    };
    let lastTextLen = 0;

    // --- 控制按钮 ---
    const replayBtn = mkBtn('↻', '重播');
    replayBtn.addEventListener('click', e => { e.stopPropagation(); restart(); });
    ctrl.appendChild(replayBtn);
    if (env.openTheater) {
        const fsBtn = mkBtn('⛶', '全屏剧场');
        fsBtn.addEventListener('click', e => { e.stopPropagation(); env.openTheater(script); });
        ctrl.appendChild(fsBtn);
    }

    function mkBtn(icon, title) {
        const b = document.createElement('button');
        b.className = 'vnl-btn'; b.textContent = icon; b.title = title;
        return b;
    }

    // --- 场景 ---
    let curScene = null;
    function setScene(cat) {
        if (!cat || cat === curScene) return;
        curScene = cat;
        bgBack.style.backgroundImage = `url("${sceneBG(cat)}")`;
        bgBack.style.opacity = '1';
        bgFront.style.opacity = '0';
        const t = bgFront; bgFront = bgBack; bgBack = t;
        if (S.weather) weather.className = 'vnl-weather ' + (weatherOf(cat) || '');
        else weather.className = 'vnl-weather';
    }

    // --- 立绘 ---
    function addSprite(name, expr) {
        if (state.onStage.has(name)) {
            if (expr) state.onStage.get(name).expr = expr;
            const node = state.onStage.get(name).node;
            const img = node.querySelector('img');
            const mapped = env.resolveChar ? env.resolveChar(name) : null;
            if (!mapped) img.src = silhouetteURI(name, expr || state.onStage.get(name).expr);
            return;
        }
        // 超过 3 个：移除最早且当前不在说话的
        if (state.onStage.size >= 3) {
            const first = state.onStage.keys().next().value;
            const info = state.onStage.get(first);
            info.node.remove(); state.onStage.delete(first);
        }
        const node = document.createElement('div');
        node.className = 'vnl-sprite';
        const img = document.createElement('img');
        img.alt = name; img.draggable = false;
        const mapped = env.resolveChar ? env.resolveChar(name) : null;
        img.src = mapped || silhouetteURI(name, expr);
        const label = document.createElement('div');
        label.className = 'vnl-sname'; label.textContent = name;
        node.append(img, label);
        sprites.appendChild(node);
        state.onStage.set(name, { expr, node });
    }

    function setActive(name) {
        for (const [n, info] of state.onStage) {
            info.node.classList.toggle('active', n === name);
        }
    }

    // --- 段落应用 ---
    function applyDir(d) {
        if (d.scene) setScene(d.scene);
        if (d.bgm) bgm.setMood(d.bgm);
        if (d.char) { addSprite(d.char.name, d.char.expr); setActive(d.char.name); }
    }

    function renderSeg(seg, instant) {
        state.interactive = false;
        lastTextLen = (seg.text || '').length;
        if (seg.t === 'say') {
            const who = seg.who;
            if (who) {
                addSprite(who);
                setActive(who);
                nameEl.style.display = '';
                nameEl.textContent = who;
                nameEl.classList.toggle('vnl-user', who === env.userName);
            } else {
                nameEl.style.display = 'none';
            }
            textEl.className = 'vnl-text';
            typeOut(seg.text, instant);
        } else if (seg.t === 'narr') {
            nameEl.style.display = 'none';
            setActive(null);
            textEl.className = 'vnl-text vnl-narr';
            typeOut(seg.text, instant);
        } else if (seg.t === 'choice') {
            nameEl.style.display = 'none';
            textEl.className = 'vnl-text vnl-narr';
            textEl.textContent = '请做出选择：';
            renderChoices(textEl, seg.opts, {
                send: S.sendChoice,
                sendUserMessage: env.sendUserMessage,
                onPick: () => next(),
            });
            state.interactive = true;
        } else if (seg.t === 'qte') {
            nameEl.style.display = 'none';
            textEl.className = 'vnl-text vnl-narr';
            textEl.textContent = seg.text;
            renderQTE(textEl, () => setTimeout(() => next(), 900));
            state.interactive = true;
        }
    }

    function typeOut(text, instant) {
        stopTyper();
        if (instant || S.typeMs <= 5) { textEl.textContent = text; return; }
        startTyper(textEl, text, S.typeMs, () => {
            if (!hintEl.parentNode) dialog.appendChild(hintEl);
        });
    }

    const hintEl = document.createElement('div');
    hintEl.className = 'vnl-next-hint'; hintEl.textContent = '▼ 点击继续';

    // --- 推进 ---
    function next() {
        if (state.disposed) return;
        if (typerActive()) { finishTyper(); return; }
        if (state.interactive) return;
        if (state.ended) { restart(); return; }
        do {
            state.ptr++;
            if (state.ptr >= segs.length) { showEnd(); return; }
            const s = segs[state.ptr];
            if (s.t === 'dir') applyDir(s);
        } while (segs[state.ptr].t === 'dir');
        hintEl.remove();
        renderSeg(segs[state.ptr], false);
    }

    function showEnd() {
        state.ended = true;
        state.interactive = false;
        stopTyper();
        nameEl.style.display = 'none';
        textEl.className = 'vnl-text vnl-narr';
        textEl.textContent = '—— 剧终 ——';
        const row = document.createElement('div');
        row.className = 'vnl-endrow';
        const replay = document.createElement('button');
        replay.className = 'vnl-endbtn'; replay.textContent = '↻ 重播';
        replay.addEventListener('click', e => { e.stopPropagation(); restart(); });
        row.appendChild(replay);
        if (env.openTheater) {
            const fs = document.createElement('button');
            fs.className = 'vnl-endbtn'; fs.textContent = '⛶ 全屏剧场';
            fs.addEventListener('click', e => { e.stopPropagation(); env.openTheater(script); });
            row.appendChild(fs);
        }
        textEl.appendChild(row);
    }

    function restart() {
        state.ptr = -1; state.ended = false; state.interactive = false;
        sprites.innerHTML = ''; state.onStage.clear();
        next();
    }

    function jumpToEnd() {
        stopTyper();
        let lastSeg = null;
        for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            if (s.t === 'dir') applyDir(s);
            else lastSeg = s;
        }
        state.ptr = segs.length - 1;
        if (lastSeg) renderSeg(lastSeg, true);
        showEnd();
    }

    el.addEventListener('click', e => {
        if (e.target.closest('.vnl-btn, .vnl-endbtn, .vnl-choice-btn, .vnl-qte-bar')) return;
        next();
    });

    // 初始状态（猜不到场景时用默认室内，避免黑屏）
    setScene(script.scene || '室内');
    if (script.bgm) bgm.setMood(script.bgm);

    return { el, next, jumpToEnd, restart, script, get _lastTextLen() { return lastTextLen; }, dispose() { state.disposed = true; stopTyper(); el.remove(); } };
}

// ---------- 挂载到消息 ----------
// envFactory(): 每次 mount 时提供最新 env（设置/角色解析可能变化）
let _envFactory = null;
function bindEnvFactory(f) { _envFactory = f; }

function mountOne(chatArr, id, opts = {}) {
    const env = _envFactory();
    const S = env.settings;
    const msg = chatArr[id];
    if (!msg || msg.is_user || !msg.mes) return;
    const textEl = document.querySelector(`.mes[mesid="${id}"] .mes_text`);
    if (!textEl) return;
    // 清理旧舞台
    textEl.querySelectorAll(':scope > .vnl-stage').forEach(n => n.remove());
    textEl.classList.remove('vnl-active');
    if (!S.enabled) return;

    const script = parseMessage(msg.mes, env.ctxInfo);
    if (!script || !script.usable) return; // 解析失败 → 保留原文，永不白屏

    const stage = createStage(script, env);
    textEl.appendChild(stage.el);
    if (!S.showRaw) textEl.classList.add('vnl-active');
    if (opts.autoplay) stage.next();
    else stage.jumpToEnd();
    return stage;
}

function renderAll(chatArr, opts = {}) {
    const env = _envFactory();
    // 全量清理（聊天切换后 DOM 是新的，但稳妥起见）
    document.querySelectorAll('.mes_text.vnl-active').forEach(el => el.classList.remove('vnl-active'));
    document.querySelectorAll('.vnl-stage').forEach(el => el.remove());
    if (!env.settings.enabled) return;
    const ids = [];
    for (let i = 0; i < chatArr.length; i++) {
        const m = chatArr[i];
        if (!m.is_user && m.mes && m.mes.trim()) ids.push(i);
    }
    const recent = ids.slice(-Math.max(1, env.settings.historyCount));
    for (const id of recent) {
        mountOne(chatArr, id, { autoplay: id === ids[ids.length - 1] && !!opts.autoplayLast });
    }
}

export { createStage, mountOne, renderAll, bindEnvFactory, stopTyper };
