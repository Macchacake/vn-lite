// ============================================
// settings.js — 设置持久化 + 扩展面板 UI
// 通过 init() 注入 ST 的 extension_settings / saveSettingsDebounced
// ============================================

const DEFAULTS = {
    enabled: true,
    mode: 'smart',      // 'smart' 智能模式 | 'protocol' 协议模式
    typeMs: 28,         // 打字机每字毫秒
    fontSize: 15,
    bgmOn: false,
    bgmVol: 0.3,
    showRaw: false,     // 舞台下方保留原始文本
    sendChoice: true,   // 选择题点选后发送到聊天
    historyCount: 6,    // 最近 N 条 AI 消息挂舞台
    weather: true,     // CSS 天气氛围
    maps: { chars: {}, scenes: {} },  // 角色/场景素材映射
    // AI 绘图（ComfyUI，电脑端运行，手机填局域网地址）
    sdOn: false,
    sdUrl: '',          // 例：http://192.168.1.100:8188
    sdModel: '',        // 留空自动选择
};

let S = null;             // 当前设置（extension_settings.vnLite）
let _save = null;         // saveSettingsDebounced
let _hooks = {};          // onChanged(mode/enabled)、素材变更回调

function init(extSettings, saveFn, hooks = {}) {
    _save = saveFn;
    _hooks = hooks;
    extSettings.vnLite = Object.assign({}, DEFAULTS, extSettings.vnLite || {});
    extSettings.vnLite.maps = Object.assign({ chars: {}, scenes: {} }, extSettings.vnLite.maps);
    S = extSettings.vnLite;
    buildPanel();
    return S;
}

function get() { return S; }
function save() { try { _save && _save(); } catch (e) { console.warn('[VN-Lite] 保存设置失败', e); } }

// ---------- 面板 ----------
function buildPanel() {
    const $host = document.getElementById('extensions_settings2');
    if (!$host || document.getElementById('vnl-panel')) return;

    const wrap = document.createElement('div');
    wrap.className = 'vnl-set';
    wrap.innerHTML = panelHTML();
    $host.appendChild(wrap);

    // --- 主开关 ---
    const en = wrap.querySelector('#vnl-enabled');
    en.checked = S.enabled;
    en.addEventListener('change', () => {
        S.enabled = en.checked;
        save();
        fireChanged();
    });

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
    bindRange(wrap, '#vnl-bgmvol', Math.round(S.bgmVol * 100), v => { S.bgmVol = v / 100; });

    // --- 复选框 ---
    bindCheck(wrap, '#vnl-bgmon', S.bgmOn, v => { S.bgmOn = v; });
    bindCheck(wrap, '#vnl-showraw', S.showRaw, v => { S.showRaw = v; });
    bindCheck(wrap, '#vnl-sendchoice', S.sendChoice, v => { S.sendChoice = v; });
    bindCheck(wrap, '#vnl-weather', S.weather, v => { S.weather = v; });

    // --- AI 绘图（ComfyUI） ---
    const sdOn = wrap.querySelector('#vnl-sdon');
    sdOn.checked = S.sdOn;
    sdOn.addEventListener('change', () => { S.sdOn = sdOn.checked; save(); });
    const sdUrl = wrap.querySelector('#vnl-sdurl');
    sdUrl.value = S.sdUrl;
    sdUrl.addEventListener('change', () => { S.sdUrl = sdUrl.value.trim(); save(); });
    wrap.querySelector('#vnl-sdtest').addEventListener('click', async () => {
        const out = wrap.querySelector('#vnl-sdtest-out');
        out.textContent = '测试中…';
        const { testConnection } = await import('./sd.js');
        const model = await testConnection(S);
        out.textContent = model ? '✓ 已连接，模型：' + model : '✗ 无法连接（检查地址、ComfyUI 是否已启动、防火墙）';
    });

    // --- 素材映射编辑器 ---
    bindMapEditor(wrap, 'chars', '角色名', '立绘图片 URL（留空用剪影）');
    bindMapEditor(wrap, 'scenes', '场景类目', '背景图片 URL（留空用内置 SVG）');

    applyFont();
}

function applyFont() {
    document.documentElement.style.setProperty('--vnl-fs', S.fontSize + 'px');
}

function fireChanged() {
    _hooks.onChanged && _hooks.onChanged(S);
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
}

function bindCheck(wrap, sel, val, setter) {
    const el = wrap.querySelector(sel);
    if (!el) return;
    el.checked = val;
    el.addEventListener('change', () => { setter(el.checked); save(); });
}

function bindMapEditor(wrap, key, namePh, urlPh) {
    const tbody = wrap.querySelector(`#vnl-map-${key} tbody`);
    const addBtn = wrap.querySelector(`#vnl-map-${key}-add`);

    const redraw = () => {
        tbody.innerHTML = '';
        const entries = Object.entries(S.maps[key] || {});
        if (!entries.length) {
            tbody.innerHTML = `<tr><td colspan="3" style="color:#8d99ad;font-size:12px;padding:6px;">（暂无自定义${key === 'chars' ? '立绘' : '背景'}，使用内置素材）</td></tr>`;
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

function panelHTML() {
    return `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>文游Lite · 轻量视觉小说</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="vnl-set-row">
                <label>启用演出</label>
                <input type="checkbox" id="vnl-enabled">
            </div>
            <div class="vnl-set-row">
                <label>模式</label>
                <label><input type="radio" name="vnl-mode" value="smart"> 智能（零配置）</label>
                <label><input type="radio" name="vnl-mode" value="protocol"> 协议（注入提示词）</label>
            </div>
            <small>智能模式：任何卡直接用，自动识别对话与场景。协议模式：向 AI 注入演出标签规范，画面更精准。</small>
            <div class="vnl-set-row">
                <label>打字速度 <span id="vnl-typems-val"></span>ms</label>
                <input type="range" id="vnl-typems" min="5" max="90" step="1">
            </div>
            <div class="vnl-set-row">
                <label>正文字号 <span id="vnl-fontsize-val"></span>px</label>
                <input type="range" id="vnl-fontsize" min="12" max="20" step="1">
            </div>
            <div class="vnl-set-row">
                <label>演出条数 <span id="vnl-history-val"></span></label>
                <input type="range" id="vnl-history" min="1" max="20" step="1">
            </div>
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
            <div class="vnl-set-row">
                <label>舞台下方保留原文</label>
                <input type="checkbox" id="vnl-showraw">
            </div>
            <div class="vnl-set-row">
                <label>选择题发送到聊天</label>
                <input type="checkbox" id="vnl-sendchoice">
            </div>
            <hr>
            <b>AI 绘图（CG）</b>
            <small>需要电脑端运行 ComfyUI（--listen 模式）。开启后，AI 在重要剧情节点自动生成插画。手机使用时填写电脑的局域网地址。</small>
            <div class="vnl-set-row">
                <label>启用 AI 绘图</label>
                <input type="checkbox" id="vnl-sdon">
            </div>
            <div class="vnl-set-row">
                <label>ComfyUI 地址</label>
                <input type="text" id="vnl-sdurl" placeholder="http://192.168.x.x:8188" style="flex:1">
            </div>
            <div class="vnl-set-row">
                <button class="vnl-map-add" id="vnl-sdtest" style="flex:0 0 auto">测试连接</button>
                <small id="vnl-sdtest-out" style="flex:1"></small>
            </div>
            <hr>
            <b>角色立绘映射</b>
            <small>角色名 → 图片 URL（http 链接或 data:image base64）。未映射的角色使用彩色剪影。角色卡头像会自动使用。</small>
            <table class="vnl-map-table" id="vnl-map-chars"><tbody></tbody></table>
            <button class="vnl-map-add" id="vnl-map-chars-add">+ 添加角色立绘</button>
            <b>场景背景映射</b>
            <small>场景类目（教室/街道/海边/夜空…共21种）→ 图片 URL。未映射使用内置 SVG。</small>
            <table class="vnl-map-table" id="vnl-map-scenes"><tbody></tbody></table>
            <button class="vnl-map-add" id="vnl-map-scenes-add">+ 添加场景背景</button>
        </div>
    </div>`;
}

export { init, get, save, DEFAULTS };
