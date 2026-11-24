// ============================================
// minigame.js — 轻量剧情小游戏：选择题 + 节奏 QTE + 骰子判定 + 自由输入
// ============================================

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// 选择题：第一次点=选中高亮，第二次点同一个=确认发送。
// 为什么要两次：手机上误触很多，一碰就把行动发给 AI 会骑虎难下；
// 先选中再确认，玩家有一次反悔机会（点别的选项可直接改选）。
function renderChoices(container, opts, cfg) {
    const wrap = document.createElement('div');
    wrap.className = 'vnl-choices';
    if (cfg && cfg.note) {
        const note = document.createElement('div');
        note.className = 'vnl-choice-note';
        note.textContent = cfg.note;
        wrap.appendChild(note);
    }
    let picked = false;      // 已确认发送
    let armed = null;        // 已选中、等待二次确认的按钮
    const willSend = !!(cfg && cfg.send && cfg.sendUserMessage);
    const hint = document.createElement('div');
    hint.className = 'vnl-choice-hint';
    hint.textContent = willSend ? '点选行动，再点一次确认发送' : '点选行动，再点一次确认';
    wrap.appendChild(hint);

    function disarm() {
        for (const b of wrap.querySelectorAll('.vnl-choice-btn')) {
            b.classList.remove('armed');
            b.textContent = b.dataset.opt || '';
        }
        armed = null;
    }

    for (const opt of opts) {
        const btn = document.createElement('button');
        btn.className = 'vnl-choice-btn';
        btn.textContent = opt;
        btn.dataset.opt = opt;
        btn.addEventListener('click', e => {
            e.stopPropagation();
            if (picked) return;
            // 第一次点（或点另一个选项）：只选中，不发送
            if (armed !== btn) {
                disarm();
                armed = btn;
                btn.classList.add('armed');
                btn.textContent = '✓ ' + opt + (willSend ? '　（再点一次发送）' : '　（再点一次确认）');
                hint.textContent = willSend
                    ? '再点一次高亮的行动即可发送；点别的行动可改选'
                    : '再点一次高亮的行动即可继续；点别的行动可改选';
                return;
            }
            // 第二次点同一个：确认发送
            picked = true;
            btn.classList.add('picked');
            hint.textContent = willSend ? '已发送，等待剧情继续…' : '继续…';
            if (cfg.send && cfg.sendUserMessage) {
                try { cfg.sendUserMessage(opt); } catch (err) { console.warn('[VN-Lite] 发送选择失败', err); }
            }
            setTimeout(() => cfg.onPick && cfg.onPick(opt), 350);
        });
        wrap.appendChild(btn);
    }
    container.appendChild(wrap);
}

// 节奏 QTE：来回扫动的标记，点击停在中心区域得分
function renderQTE(container, onDone) {
    const bar = document.createElement('div');
    bar.className = 'vnl-qte-bar';
    bar.innerHTML = '<div class="vnl-qte-zone"></div><div class="vnl-qte-mark"></div>';
    const mark = bar.querySelector('.vnl-qte-mark');
    const tip = document.createElement('div');
    tip.className = 'vnl-qte-tip';
    tip.textContent = '⏱ 看准时机点击，让光标停在绿色区域！';

    let raf = 0, pos = 0, dir = 1, done = false;
    const t0 = performance.now();
    function loop(now) {
        const dt = (now - t0) % 1700 / 1700; // 1.7s 一个来回
        pos = dt < 0.5 ? dt * 2 : (1 - dt) * 2; // 0..1..0
        mark.style.left = (pos * 95) + '%';
        if (!done) raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    bar.addEventListener('click', e => {
        e.stopPropagation();
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        const score = Math.round(Math.max(0, 100 - Math.abs(pos - 0.5) * 200));
        const grade = score >= 90 ? '完美！' : score >= 60 ? '不错' : '失手了…';
        tip.textContent = `${grade}（${score} 分）`;
        setTimeout(onDone, 800);
    });
    // 4 秒未操作视为放弃
    setTimeout(() => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        tip.textContent = '错过了…';
        setTimeout(onDone, 500);
    }, 4200);

    container.append(bar, tip);
}

// 骰子判定（RPG 风）：点击掷骰 → 滚动动画 → 结算成败
// cfg: { n, faces, target, okText, failText, send, sendUserMessage, onDone }
function renderDice(container, cfg) {
    const { n = 1, faces = 6, target = 1 } = cfg;
    const box = document.createElement('div');
    box.className = 'vnl-dice';
    box.innerHTML = `
        <div class="vnl-dice-title">🎲 掷骰判定（${n}d${faces} · 目标 ≥ ${target}）</div>
        <div class="vnl-dice-row"></div>
        <button class="vnl-menu-btn vnl-dice-roll">🎲 掷 骰</button>
        <div class="vnl-dice-result"></div>`;
    const row = box.querySelector('.vnl-dice-row');
    const rollBtn = box.querySelector('.vnl-dice-roll');
    const resultEl = box.querySelector('.vnl-dice-result');
    for (let i = 0; i < n; i++) {
        const d = document.createElement('span');
        d.className = 'vnl-die';
        d.textContent = '🎲';
        row.appendChild(d);
    }
    const dice = row.querySelectorAll('.vnl-die');

    // 骰面显示：6 面内用骰子符号，否则数字
    const face = v => faces <= 6 ? ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][v - 1] : String(v);

    let resultShown = false, done = false;
    rollBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (done) return;
        if (resultShown) { // 已出结果 → 继续
            done = true;
            setTimeout(() => cfg.onDone && cfg.onDone(), 100);
            return;
        }
        dice.forEach(d => d.classList.add('rolling'));
        let flips = 0;
        const iv = setInterval(() => {
            dice.forEach(d => { d.textContent = face(1 + Math.floor(Math.random() * faces)); });
            if (++flips >= 10) {
                clearInterval(iv);
                let total = 0;
                const vals = [];
                dice.forEach(d => {
                    const v = 1 + Math.floor(Math.random() * faces);
                    vals.push(v); total += v;
                    d.textContent = face(v);
                    d.classList.remove('rolling');
                });
                const ok = total >= target;
                resultEl.innerHTML =
                    `<div class="vnl-dice-total">${vals.join(' + ')} = <b>${total}</b></div>` +
                    `<div class="vnl-dice-verdict ${ok ? 'ok' : 'no'}">${ok ? '✔ ' : '✘ '}${esc(ok ? (cfg.okText || '成功！') : (cfg.failText || '失败…'))}</div>`;
                resultShown = true;
                rollBtn.textContent = '▶ 继续';
                if (cfg.send && cfg.sendUserMessage) {
                    try { cfg.sendUserMessage(`（掷骰 ${n}d${faces}=${total}，目标≥${target}：${ok ? '成功' : '失败'}）`); } catch (err) { console.warn('[VN-Lite] 发送骰子结果失败', err); }
                }
            }
        }, 90);
    });
    container.appendChild(box);
}

// 自由输入（AI Dungeon 风）：输入框 + 发送按钮
// cfg: { hint, sendUserMessage, onDone }
function renderInput(container, cfg) {
    const box = document.createElement('div');
    box.className = 'vnl-input';
    box.innerHTML = `
        <div class="vnl-input-hint">${esc(cfg.hint || '输入你的行动')}</div>
        <div class="vnl-input-row">
            <input type="text" class="vnl-input-field" placeholder="输入后点发送…">
            <button class="vnl-menu-btn vnl-input-send">发送</button>
        </div>`;
    const field = box.querySelector('.vnl-input-field');
    const sendBtn = box.querySelector('.vnl-input-send');
    let sent = false;
    function submit() {
        const v = field.value.trim();
        if (!v || sent) return;
        sent = true;
        field.disabled = true;
        sendBtn.disabled = true;
        sendBtn.textContent = '已发送';
        try { cfg.sendUserMessage(v); } catch (err) { console.warn('[VN-Lite] 发送输入失败', err); }
        setTimeout(() => cfg.onDone && cfg.onDone(), 400);
    }
    box.addEventListener('click', e => e.stopPropagation()); // 防误触推进
    sendBtn.addEventListener('click', e => { e.stopPropagation(); submit(); });
    field.addEventListener('keydown', e => {
        e.stopPropagation(); // 防止触发剧场快捷键
        if (e.key === 'Enter') submit();
    });
    container.appendChild(box);
}

export { renderChoices, renderQTE, renderDice, renderInput };
