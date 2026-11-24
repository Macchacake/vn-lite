// ============================================
// settings.js — 设置持久化 + 文游内设置面板
// 设置不挂在酒馆扩展设置里，由 theater.js 在
// 文游全屏界面内调用 mountPanel() 渲染。
// ============================================

import { DEFAULT_PROTOCOL } from './protocol.js';

const DEFAULTS = {
    enabled: true,
    mode: 'smart',      // 'smart' 智能模式 | 'protocol' 协议模式
    typeMs: 28,         // 打字机每字毫秒
    fontSize: 15,
    chunk: 60,          // 断句长度：一屏最多多少字
    bgmOn: false,
    bgmVol: 0.3,
    sendChoice: true,   // 选择题点选后发送到聊天
    historyCount: 6,    // 进入文游时载入最近 N 条 AI 消息
    weather: true,      // CSS 天气氛围
    maps: { chars: {}, scenes: {} },  // 角色/场景素材映射（手动指定图片 URL）

    // 协议注入：留空 = 用内置默认
    protocol: '',

    // AI 绘图（ComfyUI，电脑端运行）
    sdOn: false,
    sdUrl: '',          // 例：http://192.168.1.100:8188
    sdHistory: [],      // 自动记录曾经填过的地址，供自动探测/回退使用
    sdModel: '',        // 留空自动选择
    autoArt: true,      // 自动生图（背景/立绘/物品）
    preGen: true,       // 提前预生成下一幕要用的素材
    preGenMax: 3,       // 每次预生成最多几张
    artStyle: 'anime style, detailed, cinematic lighting',
    portraitTpl: 'anime character portrait, upper body, looking at viewer, detailed face, soft lighting',
    itemTpl: 'game item icon, single object, centered, simple dark background, soft rim light',
    artPrompts: {},     // 角色/物品 → 额外英文提示词
    artCache: { bg: {}, char: {}, item: {}, cg: {} },
    gallery: [],        // 图集（只存 ComfyUI 文件名）
};

let S = null;             // 当前设置（extension_settings.vnLite）
let _save = null;         // saveSettingsDebounced
let _hooks = {};          // onChanged

function init(extSettings, saveFn, hooks = {}) {
    _save = saveFn;
    _hooks = hooks;
    extSettings.vnLite = Object.assign({}, DEFAULTS, extSettings.vnLite || {});
    const v = extSettings.vnLite;
    v.maps = Object.assign({ chars: {}, scenes: {} }, v.maps);
    v.sdHistory = Array.isArray(v.sdHistory) ? v.sdHistory : [];
    v.artPrompts = (v.artPrompts && typeof v.artPrompts === 'object') ? v.artPrompts : {};
    v.artCache = Object.assign({ bg: {}, char: {}, item: {}, cg: {} }, v.artCache);
    v.gallery = Array.isArray(v.gallery) ? v.gallery : [];
    S = v;
    applyFont();
    return S;
}

function get() { return S; }
function save() { try { _save && _save(); } catch (e) { console.warn('[VN-Lite] 保存设置失败', e); } }

function applyFont() {
    if (!S) return;
    document.documentElement.style.setProperty('--vnl-fs', S.fontSize + 'px');
}

function fireChanged() {
    _hooks.onChanged && _hooks.onChanged(S);
}

// ---------- 文游内设置面板 ----------
// 由 theater.js 传入容器；每次打开设置页时重建，保证状态最新。
function mountPanel(host, hooks = {}) {
    if (!host) return null;
    host.innerHTML = settingsHTML();
    const wrap = host.querySelector('.vnl-set');
    if (wrap) bindPanel(wrap, hooks);
    applyFont();
    return wrap;
}

function bindPanel(wrap, hooks) {
    // --- 主开关 ---
    const en = wrap.querySelector('#vnl-enabled');
    if (en) {
        en.checked = S.enabled;
        en.addEventListener('change', () => {
            S.enabled = en.checked;
            save();
            fireChanged();
        });
    }

    // --- 模式 ---
    wrap.querySelectorAll('input[name=vnl-mode]').forEach(r => {
        r.checked = r.value === S.mode;
        r.addEventListener('change', () => {
            if (r.checked) { S.mode = r.value; save(); fireChanged(); }
        });
    });

    // --- 滑条 ---
    bindRange(wrap, '#vnl-typems', S.typeMs, v => { S.typeMs = v; });
    bindRange(wrap, '#vnl-fontsize', S.fontSize, v => { S.fontSize = v; applyFont(); });
    bindRange(wrap, '#vnl-history', S.historyCount, v => { S.historyCount = v; });
    bindRange(wrap, '#vnl-chunk', S.chunk, v => { S.chunk = v; });
    bindRange(wrap, '#vnl-bgmvol', Math.round(S.bgmVol * 100), v => { S.bgmVol = v / 100; });
    bindRange(wrap, '#vnl-pregemax', S.preGenMax, v => { S.preGenMax = v; });

    // --- 复选框 ---
    bindCheck(wrap, '#vnl-bgmon', S.bgmOn, v => { S.bgmOn = v; });
    bindCheck(wrap, '#vnl-weather', S.weather, v => { S.weather = v; });
    bindCheck(wrap, '#vnl-sendchoice', S.sendChoice, v => { S.sendChoice = v; });
    bindCheck(wrap, '#vnl-autoart', S.autoArt, v => { S.autoArt = v; });
    bindCheck(wrap, '#vnl-pregen', S.preGen, v => { S.preGen = v; });

    // --- 协议注入（可编辑） ---
    const proto = wrap.querySelector('#vnl-protocol');
    if (proto) {
        proto.value = S.protocol || '';
        proto.placeholder = DEFAULT_PROTOCOL;
        const apply = () => {
            S.protocol = proto.value.trim();
            save();
            fireChanged();
            flash(wrap, S.protocol ? '已保存自定义协议' : '已清空，使用内置默认协议');
        };
        proto.addEventListener('change', apply);
        proto.addEventListener('blur', apply);
        const reset = wrap.querySelector('#vnl-protocol-reset');
        if (reset) {
            reset.addEventListener('click', () => {
                S.protocol = '';
                proto.value = '';
                save();
                fireChanged();
                flash(wrap, '已恢复内置默认协议');
            });
        }
        const fill = wrap.querySelector('#vnl-protocol-fill');
        if (fill) {
            fill.addEventListener('click', () => {
                proto.value = S.protocol || DEFAULT_PROTOCOL;
                flash(wrap, '已填入当前生效的协议，可直接修改');
            });
        }
    }

    // --- AI 绘图（ComfyUI） ---
    const sdOn = wrap.querySelector('#vnl-sdon');
    if (sdOn) {
        sdOn.checked = S.sdOn;
        sdOn.addEventListener('change', () => { S.sdOn = sdOn.checked; save(); fireChanged(); });
    }

    ['#vnl-artstyle', '#vnl-portraittpl', '#vnl-itemtpl'].forEach(sel => {
        const el = wrap.querySelector(sel);
        if (!el) return;
        const key = sel === '#vnl-artstyle' ? 'artStyle' : sel === '#vnl-portraittpl' ? 'portraitTpl' : 'itemTpl';
        el.value = S[key] || '';
        el.addEventListener('change', () => { S[key] = el.value.trim(); save(); });
    });

    const sdUrl = wrap.querySelector('#vnl-sdurl');
    if (sdUrl) {
        sdUrl.value = S.sdUrl;
        const rememberUrl = (raw) => {
            const b = String(raw || '').trim();
            if (!b) return;
            S.sdUrl = b;
            S.sdHistory = Array.isArray(S.sdHistory) ? S.sdHistory : [];
            if (!S.sdHistory.includes(b)) {
                S.sdHistory.unshift(b);
                S.sdHistory = S.sdHistory.slice(0, 8);
            }
            save();
        };
        sdUrl.addEventListener('change', () => rememberUrl(sdUrl.value));

        const out = wrap.querySelector('#vnl-sdtest-out');

        const scanBtn = wrap.querySelector('#vnl-sdscan');
        if (scanBtn) {
            scanBtn.addEventListener('click', async () => {
                const lines = [];
                out.textContent = '自动探测中…';
                try {
                    const { detectComfyUI } = await import('./sd.js');
                    const found = await detectComfyUI(S, (msg) => {
                        lines.push(msg);
                        out.textContent = lines.join('\n');
                    });
                    if (found) {
                        rememberUrl(found.base);
                        sdUrl.value = found.base;
                        lines.push('✓ 已自动选用：' + found.base + '（模型 ' + found.model + '）');
                    } else {
                        lines.push('✗ 未找到可用地址。请确认 ComfyUI 已启动、防火墙放行，或手动填写可访问的地址。');
                    }
                } catch (e) {
                    lines.push('✗ 探测失败：' + (e && e.message ? e.message : e));
                }
                out.textContent = lines.join('\n');
            });
        }

        const testBtn = wrap.querySelector('#vnl-sdtest');
        if (testBtn) {
            testBtn.addEventListener('click', async () => {
                out.textContent = '测试中…';
                try {
                    const { testConnection } = await import('./sd.js');
                    const r = await testConnection(S, 8000);
                    out.textContent = r.ok
                        ? '✓ 已连接：' + r.base + '\n模型：' + r.model
                        : '✗ ' + r.reason + (r.base ? '\n地址：' + r.base : '');
                } catch (e) {
                    out.textContent = '✗ 测试失败：' + (e && e.message ? e.message : e);
                }
            });
        }
    }

    // --- 素材缓存 / 图集 ---
    const statsEl = wrap.querySelector('#vnl-art-stats');
    const refreshStats = () => {
        if (!statsEl) return;
        const c = S.artCache || {};
        statsEl.textContent = `已生成：背景 ${Object.keys(c.bg || {}).length} · 立绘 ${Object.keys(c.char || {}).length} · 物品 ${Object.keys(c.item || {}).length} · 插画 ${Object.keys(c.cg || {}).length}`;
    };
    refreshStats();
    const clearBtn = wrap.querySelector('#vnl-art-clear');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            if (!confirm('清空素材缓存？下次演出会重新生成（ComfyUI 里的文件不会删）。')) return;
            const { clearCache } = await import('./art.js');
            clearCache();
            refreshStats();
            flash(wrap, '素材缓存已清空');
        });
    }
    const galBtn = wrap.querySelector('#vnl-open-gallery');
    if (galBtn) {
        galBtn.addEventListener('click', () => {
            if (hooks && hooks.openGallery) hooks.openGallery();
        });
    }

    // --- 素材映射编辑器 ---
    bindMapEditor(wrap, 'chars', '角色名', '立绘图片 URL（留空用剪影）');
    bindMapEditor(wrap, 'scenes', '场景类目', '背景图片 URL（留空用内置 SVG）');
}

function flash(wrap, msg) {
    const el = wrap.querySelector('#vnl-set-flash');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('vnl-set-flash-on');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('vnl-set-flash-on'), 1800);
}

function bindRange(wrap, sel, val, setter) {
    const el = wrap.querySelector(sel);
    if (!el) return;
    el.value = val;
    const out = wrap.querySelector(sel + '-val');
    if (out) out.textContent = el.value;
    el.addEventListener('input', () => {
        setter(Number(el.value));
        if (out) out.textContent = el.value;
        save();
    });
    // 松手后再触发重渲染，避免拖动时频繁重建舞台
    el.addEventListener('change', fireChanged);
}

function bindCheck(wrap, sel, val, setter) {
    const el = wrap.querySelector(sel);
    if (!el) return;
    el.checked = val;
    el.addEventListener('change', () => { setter(el.checked); save(); fireChanged(); });
}

function bindMapEditor(wrap, key, namePh, urlPh) {
    const tbody = wrap.querySelector(`#vnl-map-${key} tbody`);
    const addBtn = wrap.querySelector(`#vnl-map-${key}-add`);
    if (!tbody || !addBtn) return;

    const redraw = () => {
        tbody.innerHTML = '';
        const entries = Object.entries(S.maps[key] || {});
        if (!entries.length) {
            tbody.innerHTML = `<tr><td colspan="3" class="vnl-map-empty">（暂无自定义${key === 'chars' ? '立绘' : '背景'}，使用内置素材）</td></tr>`;
        }
        for (const [k, v] of entries) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td style="width:32%"><input value="${escAttr(k)}" data-k="1" placeholder="${namePh}"></td>
                <td><input value="${escAttr(v)}" data-k="2" placeholder="${urlPh}"></td>
                <td style="width:30px"><button class="vnl-map-del">×</button></td>`;
            tr.querySelector('.vnl-map-del').addEventListener('click', () => {
                delete S.maps[key][k]; save(); redraw(); fireChanged();
            });
            const [inpK, inpV] = tr.querySelectorAll('input');
            inpK.addEventListener('change', () => {
                const nk = inpK.value.trim();
                if (!nk || nk === k) return;
                delete S.maps[key][k]; S.maps[key][nk] = inpV.value.trim(); save(); redraw(); fireChanged();
            });
            inpV.addEventListener('change', () => {
                S.maps[key][k] = inpV.value.trim(); save(); fireChanged();
            });
            tbody.appendChild(tr);
        }
    };
    addBtn.addEventListener('click', () => {
        S.maps[key][''] = '';
        redraw();
        const first = tbody.querySelector('input[data-k="1"]');
        if (first) first.focus();
    });
    redraw();
}

function escAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function settingsHTML() {
    return `
    <div class="vnl-set">
        <div id="vnl-set-flash" class="vnl-set-flash"></div>

        <div class="vnl-set-section">
            <div class="vnl-set-title">基本</div>
            <div class="vnl-set-row">
                <label>启用文游模式</label>
                <input type="checkbox" id="vnl-enabled">
            </div>
            <div class="vnl-set-row">
                <label>模式</label>
                <label><input type="radio" name="vnl-mode" value="smart"> 智能（零配置）</label>
                <label><input type="radio" name="vnl-mode" value="protocol"> 协议（注入提示词）</label>
            </div>
            <small>智能模式：任何卡直接用，自动识别对话与场景。协议模式：向 AI 注入演出标签规范，画面与选项更精准。</small>
        </div>

        <div class="vnl-set-section">
            <div class="vnl-set-title">协议注入（可编辑）</div>
            <small>这里的内容会作为系统提示词注入给 AI。留空则使用内置默认协议。<b>每段回复必须以 [choice:] 或 [input:] 收尾</b>，否则玩家没有可点的东西。</small>
            <textarea id="vnl-protocol" class="vnl-protocol" rows="12" spellcheck="false"></textarea>
            <div class="vnl-set-row vnl-set-btns">
                <button class="vnl-map-add" id="vnl-protocol-fill">填入当前协议</button>
                <button class="vnl-map-add" id="vnl-protocol-reset">恢复默认</button>
            </div>
        </div>

        <div class="vnl-set-section">
            <div class="vnl-set-title">演出</div>
            <div class="vnl-set-row">
                <label>打字速度 <span id="vnl-typems-val"></span>ms</label>
                <input type="range" id="vnl-typems" min="5" max="90" step="1">
            </div>
            <div class="vnl-set-row">
                <label>正文字号 <span id="vnl-fontsize-val"></span>px</label>
                <input type="range" id="vnl-fontsize" min="12" max="22" step="1">
            </div>
            <div class="vnl-set-row">
                <label>每屏字数 <span id="vnl-chunk-val"></span></label>
                <input type="range" id="vnl-chunk" min="24" max="120" step="4">
            </div>
            <div class="vnl-set-row">
                <label>载入条数 <span id="vnl-history-val"></span></label>
                <input type="range" id="vnl-history" min="1" max="20" step="1">
            </div>
            <small>「每屏字数」决定长段落怎么切屏，越小切得越碎、越像游戏。</small>
        </div>

        <div class="vnl-set-section">
            <div class="vnl-set-title">氛围</div>
            <div class="vnl-set-row">
                <label>氛围音乐</label>
                <input type="checkbox" id="vnl-bgmon">
                <label style="flex:2">音量 <span id="vnl-bgmvol-val"></span>%</label>
                <input type="range" id="vnl-bgmvol" min="0" max="100" step="5">
            </div>
            <div class="vnl-set-row">
                <label>天气氛围特效</label>
                <input type="checkbox" id="vnl-weather">
            </div>
        </div>

        <div class="vnl-set-section">
            <div class="vnl-set-title">交互</div>
            <div class="vnl-set-row">
                <label>选择题发送到聊天</label>
                <input type="checkbox" id="vnl-sendchoice">
            </div>
            <small>关闭后，选项只在文游界面内推进，不自动发送到酒馆聊天。</small>
        </div>

        <div class="vnl-set-section">
            <div class="vnl-set-title">AI 绘图（CG / 素材）</div>
            <small>ComfyUI 需以 --listen 启动。点「自动探测」会依次尝试：已填地址 → 历史地址 → 同主机 8188/8189 → 127.0.0.1。</small>
            <div class="vnl-set-row">
                <label>启用 AI 绘图</label>
                <input type="checkbox" id="vnl-sdon">
            </div>
            <div class="vnl-set-row">
                <label>ComfyUI 地址</label>
                <input type="text" id="vnl-sdurl" placeholder="http://192.168.x.x:8188" style="flex:1">
            </div>
            <div class="vnl-set-row">
                <button class="vnl-map-add" id="vnl-sdscan" style="flex:0 0 auto">自动探测</button>
                <button class="vnl-map-add" id="vnl-sdtest" style="flex:0 0 auto">测试连接</button>
                <small id="vnl-sdtest-out" style="flex:1;white-space:pre-line;word-break:break-all"></small>
            </div>
            <div class="vnl-set-row">
                <label>自动生图（背景/立绘/物品）</label>
                <input type="checkbox" id="vnl-autoart">
            </div>
            <div class="vnl-set-row">
                <label>提前预生成下一幕素材</label>
                <input type="checkbox" id="vnl-pregen">
            </div>
            <div class="vnl-set-row">
                <label>每次最多预生成 <span id="vnl-pregemax-val"></span> 张</label>
                <input type="range" id="vnl-pregemax" min="0" max="10" step="1">
            </div>
            <div class="vnl-set-row">
                <label>画风尾巴</label>
                <input type="text" id="vnl-artstyle" placeholder="anime style, detailed, cinematic lighting" style="flex:1">
            </div>
            <div class="vnl-set-row">
                <label>立绘提示词</label>
                <input type="text" id="vnl-portraittpl" placeholder="anime character portrait, upper body…" style="flex:1">
            </div>
            <div class="vnl-set-row">
                <label>物品提示词</label>
                <input type="text" id="vnl-itemtpl" placeholder="game item icon, single object…" style="flex:1">
            </div>
            <small id="vnl-art-stats"></small>
            <div class="vnl-set-row vnl-set-btns">
                <button class="vnl-map-add" id="vnl-open-gallery">查看图集</button>
                <button class="vnl-map-add" id="vnl-art-clear">清空素材缓存</button>
            </div>
        </div>

        <div class="vnl-set-section">
            <div class="vnl-set-title">角色立绘映射</div>
            <small>角色名 → 图片 URL。留空则用 AI 自动生成的立绘，再不行用彩色剪影。</small>
            <table class="vnl-map-table" id="vnl-map-chars"><tbody></tbody></table>
            <button class="vnl-map-add" id="vnl-map-chars-add">+ 添加角色立绘</button>
        </div>

        <div class="vnl-set-section">
            <div class="vnl-set-title">场景背景映射</div>
            <small>场景类目 → 图片 URL。留空则用 AI 自动生成的背景，再不行用内置 SVG。</small>
            <table class="vnl-map-table" id="vnl-map-scenes"><tbody></tbody></table>
            <button class="vnl-map-add" id="vnl-map-scenes-add">+ 添加场景背景</button>
        </div>
    </div>`;
}

export { init, get, save, mountPanel, DEFAULTS };
