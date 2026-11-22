// ============================================
// minigame.js — 轻量剧情小游戏：选择题 + 节奏 QTE
// ============================================

// 选择题：点选后高亮；可选发送到聊天
function renderChoices(container, opts, cfg) {
    const wrap = document.createElement('div');
    wrap.className = 'vnl-choices';
    let picked = false;
    for (const opt of opts) {
        const btn = document.createElement('button');
        btn.className = 'vnl-choice-btn';
        btn.textContent = opt;
        btn.addEventListener('click', e => {
            e.stopPropagation();
            if (picked) return;
            picked = true;
            btn.classList.add('picked');
            wrap.querySelectorAll('.vnl-choice-btn').forEach(b => { if (b !== btn) b.style.opacity = '0.4'; });
            if (cfg.send && cfg.sendUserMessage) {
                try { cfg.sendUserMessage(opt); } catch (err) { console.warn('[VN-Lite] 发送选择失败', err); }
            }
            setTimeout(() => cfg.onPick && cfg.onPick(), 600);
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

export { renderChoices, renderQTE };
