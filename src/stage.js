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
import { renderChoices, renderQTE, renderDice, renderInput } from './minigame.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

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
    // 字号统一走 :root --vnl-fs（settings.applyFont / 剧场菜单可实时调整）

    // 背景双层交叉淡出
    const bgA = document.createElement('div'); bgA.className = 'vnl-bg';
    const bgB = document.createElement('div'); bgB.className = 'vnl-bg'; bgB.style.opacity = '0';
    el.append(bgA, bgB);
    let bgFront = bgA, bgBack = bgB;

    const weather = document.createElement('div'); weather.className = 'vnl-weather';
    const cgLayer = document.createElement('div'); cgLayer.className = 'vnl-cg';
    const sprites = document.createElement('div'); sprites.className = 'vnl-sprites';
    const dialog = document.createElement('div'); dialog.className = 'vnl-dialog';
    dialog.innerHTML = '<div class="vnl-name" style="display:none"></div><div class="vnl-text"></div>';
    const nameEl = dialog.querySelector('.vnl-name');
    const textEl = dialog.querySelector('.vnl-text');
    // RPG 状态 HUD（[stats:] 驱动，常驻舞台顶部）
    const hud = document.createElement('div'); hud.className = 'vnl-hud';
    const ctrl = document.createElement('div'); ctrl.className = 'vnl-ctrl';
    el.append(weather, cgLayer, sprites, hud, dialog, ctrl);

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

    // --- CG 插画层（[cg:] 驱动，异步不阻塞） ---
    function showCG(prompt) {
        cgLayer.classList.add('vnl-cg-on');
        textEl.className = 'vnl-text vnl-narr';
        textEl.textContent = '（演出插画…）';
        lastTextLen = 6;
        const finish = (html) => {
            if (state.disposed) return;
            cgLayer.innerHTML = html;
        };
        if (S.sdOn && typeof env.sd === 'function') {
            finish('<div class="vnl-cg-loading"><span class="vnl-cg-spin"></span>正在绘制插画…</div>');
            env.sd(prompt).then(res => {
                if (!res || !res.url) { finish('<div class="vnl-cg-fallback">🖼 场景插画</div>'); return; }
                finish(`<img src="${res.url}" alt="CG" draggable="false">`);
            }).catch(() => finish('<div class="vnl-cg-fallback">🖼 场景插画</div>'));
        } else {
            finish('<div class="vnl-cg-fallback">🖼 场景插画</div>');
        }
    }
    function hideCG() {
        cgLayer.classList.remove('vnl-cg-on');
        cgLayer.innerHTML = '';
        sprites.style.opacity = '';
    }

    // --- 段落应用 ---
    function applyDir(d) {
        if (d.scene) setScene(d.scene);
        if (d.bgm) bgm.setMood(d.bgm);
        if (d.char) { addSprite(d.char.name, d.char.expr); setActive(d.char.name); }
    }

    function renderSeg(seg, instant) {
        state.interactive = false;
        if (seg.t !== 'cg') hideCG();
        lastTextLen = (seg.text || '').length;

        // 交互段落结束后推进：必须先解除 interactive，否则 next() 会直接返回
        const advance = () => { state.interactive = false; next(); };
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
                onPick: () => advance(),
            });
            state.interactive = true;
        } else if (seg.t === 'qte') {
            nameEl.style.display = 'none';
            textEl.className = 'vnl-text vnl-narr';
            textEl.textContent = seg.text;
            renderQTE(textEl, () => setTimeout(() => advance(), 900));
            state.interactive = true;
        } else if (seg.t === 'cg') {
            // [cg:prompt] — AI 生成插画，异步加载不阻塞演出
            nameEl.style.display = 'none';
            setActive(null);
            sprites.style.opacity = '0';
            showCG(seg.prompt);
        } else if (seg.t === 'stats') {
            // RPG 状态栏：更新 HUD 并在对话框显示快照
            nameEl.style.display = 'none';
            renderHUD(seg.items);
            textEl.className = 'vnl-text vnl-narr';
            textEl.textContent = '【状态更新】';
        } else if (seg.t === 'item') {
            nameEl.style.display = 'none';
            setActive(null);
            textEl.className = 'vnl-text';
            textEl.textContent = '';
            const toast = document.createElement('div');
            toast.className = 'vnl-sys vnl-item ' + (seg.op === '+' ? 'gain' : 'loss');
            toast.textContent = (seg.op === '+' ? '🎒 获得 ' : '📦 失去 ') + seg.name + (seg.qty > 1 ? ' ×' + seg.qty : '');
            textEl.appendChild(toast);
        } else if (seg.t === 'quest') {
            nameEl.style.display = 'none';
            setActive(null);
            textEl.className = 'vnl-text';
            textEl.textContent = '';
            const q = document.createElement('div');
            q.className = 'vnl-sys vnl-quest ' + seg.st;
            const tag = seg.st === 'done' ? '✅ 任务完成' : seg.st === 'fail' ? '💥 任务失败' : '📋 接受新任务';
            q.innerHTML = `<div class="vnl-quest-tag">${tag}</div><div class="vnl-quest-name">${esc(seg.name)}</div>` +
                (seg.desc ? `<div class="vnl-quest-desc">${esc(seg.desc)}</div>` : '');
            textEl.appendChild(q);
        } else if (seg.t === 'aff') {
            nameEl.style.display = 'none';
            setActive(null);
            textEl.className = 'vnl-text';
            textEl.textContent = '';
            const a = document.createElement('div');
            a.className = 'vnl-sys vnl-aff';
            a.textContent = (seg.delta >= 0 ? '💗 ' : '💔 ') + seg.name + ' 好感度 ' + (seg.delta >= 0 ? '+' : '') + seg.delta;
            textEl.appendChild(a);
        } else if (seg.t === 'dice') {
            nameEl.style.display = 'none';
            textEl.className = 'vnl-text';
            textEl.textContent = '';
            renderDice(textEl, {
                n: seg.n, faces: seg.faces, target: seg.target,
                okText: seg.okText, failText: seg.failText,
                send: S.sendChoice,
                sendUserMessage: env.sendUserMessage,
                onDone: () => advance(),
            });
            state.interactive = true;
        } else if (seg.t === 'input') {
            nameEl.style.display = 'none';
            textEl.className = 'vnl-text';
            textEl.textContent = '';
            renderInput(textEl, {
                hint: seg.hint,
                sendUserMessage: env.sendUserMessage,
                onDone: () => advance(),
            });
            state.interactive = true;
        }
    }

    // HUD 渲染：HP/MP 等分数值 → 血条；其他 → 数值徽章
    function renderHUD(items) {
        hud.innerHTML = '';
        for (const it of items) {
            const chip = document.createElement('div');
            chip.className = 'vnl-hud-chip';
            const m = /^(\d+)\s*\/\s*(\d+)$/.exec(it.val || '');
            if (m) {
                const cur = Number(m[1]), max = Number(m[2]);
                const pct = Math.max(0, Math.min(100, max ? cur / max * 100 : 0));
                const cls = /^hp$/i.test(it.label) ? ' hp' : /^mp$/i.test(it.label) ? ' mp' : '';
                chip.innerHTML = `<span class="vnl-hud-label">${esc(it.label)}</span>` +
                    `<span class="vnl-hud-bar"><span class="vnl-hud-fill${cls}" style="width:${pct}%"></span></span>` +
                    `<span class="vnl-hud-num">${cur}/${max}</span>`;
            } else {
                chip.innerHTML = `<span class="vnl-hud-label">${esc(it.label)}</span><span class="vnl-hud-val">${esc(it.val)}</span>`;
            }
            hud.appendChild(chip);
        }
        hud.style.display = 'flex';
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

    function showEnd(silent = false) {
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
        // 剧场模式：本幕自然演完后，通知外层衔接下一幕
        if (!silent && typeof env.onEnd === 'function') env.onEnd();
    }

    function restart() {
        state.ptr = -1; state.ended = false; state.interactive = false;
        sprites.innerHTML = ''; state.onStage.clear();
        hideCG();
        hud.style.display = 'none'; hud.innerHTML = '';
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
        showEnd(true);
    }

    // 点击推进；长按 450ms 进入快进（松开停止）
    let pressTimer = 0;
    let ffTimer = 0;
    let pressing = false;
    let longPressed = false;
    let suppressClick = false;

    function stopFF() {
        if (ffTimer) { clearInterval(ffTimer); ffTimer = 0; }
    }

    function startFF() {
        longPressed = true;
        suppressClick = true;
        stopTyper();
        stopFF();
        ffTimer = setInterval(() => {
            if (state.disposed || state.interactive || state.ended) { stopFF(); return; }
            if (typerActive()) { finishTyper(); return; }
            next();
        }, 110);
    }

    const isControl = (target) => target.closest('.vnl-btn, .vnl-endbtn, .vnl-choice-btn, .vnl-qte-bar, .vnl-dice, .vnl-input');

    el.addEventListener('pointerdown', e => {
        if (isControl(e.target)) return;
        pressing = true;
        longPressed = false;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => { if (pressing) startFF(); }, 450);
    });

    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => {
        el.addEventListener(ev, () => {
            pressing = false;
            clearTimeout(pressTimer);
            if (longPressed) {
                stopFF();
                setTimeout(() => { suppressClick = false; }, 400);
            }
        });
    });

    el.addEventListener('click', e => {
        if (suppressClick) { e.stopPropagation(); e.preventDefault(); return; }
        if (isControl(e.target)) return;
        next();
    });

    // 初始状态（猜不到场景时用默认室内，避免黑屏）
    setScene(script.scene || '室内');
    if (script.bgm) bgm.setMood(script.bgm);

    return { el, next, jumpToEnd, restart, script, get _lastTextLen() { return lastTextLen; }, get _ended() { return state.ended; }, dispose() { state.disposed = true; stopTyper(); el.remove(); } };
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
