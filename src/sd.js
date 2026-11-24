// ============================================
// sd.js — ComfyUI API 客户端（本地/局域网/Tailscale）
// 流程：/object_info 选模型 → /prompt 提交 →
//       /history 轮询 → /view 取图 → 缓存返回
// 新增：多地址自动探测 / 自动回退，全部失败返回 null
//      （调用方降级内置素材，不卡演出）
// ============================================

const CLIENT_ID = 'vn-lite-' + Math.random().toString(36).slice(2, 10);
const _modelCache = { list: null, base: null, ts: 0 };
const _imgCache = new Map();      // base::prompt -> objectURL
const _lastGood = { base: null, ts: 0 };

// ---------- 地址规范化 ----------
function normalizeBase(u) {
    let s = String(u || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    try { new URL(s); } catch { return ''; }
    return s;
}

function baseURL(S) {
    return normalizeBase(S && S.sdUrl);
}

// 候选地址：手动地址 → 历史地址 → 酒馆同主机 8188 → 127.0.0.1
function candidateBases(S) {
    const out = [];
    const add = (u) => {
        const b = normalizeBase(u);
        if (b && !out.includes(b)) out.push(b);
    };

    add(S && S.sdUrl);
    const hist = (S && S.sdHistory) || [];
    if (Array.isArray(hist)) hist.forEach(add);

    if (typeof location !== 'undefined' && location.href) {
        try {
            const here = new URL(location.href);
            if (here.hostname && /^https?:$/.test(here.protocol)) {
                // 酒馆与 ComfyUI 在同一台电脑 / 同一主机时最常见
                add(here.protocol + '//' + here.hostname + ':8188');
            }
            if (here.hostname === '127.0.0.1' || here.hostname === 'localhost') {
                add('http://127.0.0.1:8188');
                add('http://localhost:8188');
            }
        } catch { /* location 不可用时忽略 */ }
    }

    add('http://127.0.0.1:8188');
    add('http://localhost:8188');
    return out;
}

function timeoutSignal(ms) {
    if (typeof AbortController === 'undefined') return undefined;
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
}

async function probeBase(base, ms = 3000) {
    const b = normalizeBase(base);
    if (!b) return { ok: false, reason: '地址为空' };
    try {
        const r = await fetch(b + '/object_info/CheckpointLoaderSimple', { signal: timeoutSignal(ms) });
        if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status };
        const j = await r.json();
        const arr = j?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
        if (!Array.isArray(arr) || !arr.length) return { ok: false, reason: '不是 ComfyUI / 无模型' };
        return { ok: true, base: b, model: pickModel(arr), models: arr };
    } catch (e) {
        if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) {
            return { ok: false, reason: '连接超时' };
        }
        return { ok: false, reason: '无法连接 / 被浏览器拦截（CORS 或 Mixed Content）' };
    }
}

// 一键探测：按顺序试所有候选地址，返回第一个可用的
async function detectComfyUI(S, onProgress) {
    const bases = candidateBases(S);
    for (const base of bases) {
        if (onProgress) onProgress('探测 ' + base + ' …');
        const res = await probeBase(base, 2500);
        if (res.ok) {
            _lastGood.base = res.base;
            _lastGood.ts = Date.now();
            _modelCache.list = null;   // 让 listModels 重新拉一次
            _modelCache.base = null;
            return { base: res.base, model: res.model };
        }
    }
    return null;
}

// 优先用手动地址；失败时用最近可用地址；再失败才自动探测
async function resolveBase(S) {
    const primary = baseURL(S);
    if (primary) {
        const r = await probeBase(primary, 3000);
        if (r.ok) return r.base;
    }
    if (_lastGood.base && Date.now() - _lastGood.ts < 600000) {
        const r = await probeBase(_lastGood.base, 3000);
        if (r.ok) return r.base;
    }
    const found = await detectComfyUI(S);
    return found ? found.base : (primary || null);
}

// ---------- 模型列表 ----------
async function listModels(base) {
    const b = normalizeBase(base);
    if (!b) throw new Error('empty base');
    if (_modelCache.list && _modelCache.base === b && Date.now() - _modelCache.ts < 300000) {
        return _modelCache.list;
    }
    const res = await probeBase(b, 5000);
    if (!res.ok) throw new Error(res.reason);
    _modelCache.list = res.models;
    _modelCache.base = b;
    _modelCache.ts = Date.now();
    return res.models;
}

function pickModel(models) {
    return models.find(m => /animagine/i.test(m))
        || models.find(m => /xl/i.test(m))
        || models.find(m => /anything/i.test(m))
        || models[0];
}

// ---------- 最小工作流（API 格式） ----------
// SDXL 用 832x1216，SD1.5 用 512x768
function buildWorkflow(model, prompt, isXL) {
    const w = Math.random() * 4294967295 >>> 0; // 随机种子
    const pos = 'masterpiece, best quality, very aesthetic, absurdres, ' + prompt;
    const neg = 'lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, watermark, signature, blurry';
    const [W, H] = isXL ? [832, 1216] : [512, 768];
    return {
        '3': { class_type: 'KSampler', inputs: { seed: w, steps: isXL ? 26 : 22, cfg: isXL ? 6 : 7, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
        '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
        '5': { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } },
        '6': { class_type: 'CLIPTextEncode', inputs: { text: pos, clip: ['4', 1] } },
        '7': { class_type: 'CLIPTextEncode', inputs: { text: neg, clip: ['4', 1] } },
        '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
        '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'vnl_cg', images: ['8', 0] } },
    };
}

// ---------- 单个地址上的完整生成流程 ----------
async function tryGenerateOn(base, prompt, S) {
    const key = base + '::' + prompt;
    if (_imgCache.has(key)) return { url: _imgCache.get(key) };
    try {
        const models = await listModels(base);
        const model = S.sdModel && models.includes(S.sdModel) ? S.sdModel : pickModel(models);
        const isXL = /xl/i.test(model);
        const wf = buildWorkflow(model, prompt, isXL);

        const pr = await fetch(base + '/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: wf, client_id: CLIENT_ID }),
            signal: timeoutSignal(15000),
        });
        if (!pr.ok) throw new Error('prompt ' + pr.status);
        const { prompt_id } = await pr.json();
        if (!prompt_id) throw new Error('no prompt_id');

        // 轮询 history（最长 ~4 分钟）
        for (let i = 0; i < 240; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const hr = await fetch(base + '/history/' + prompt_id, { signal: timeoutSignal(8000) });
            if (!hr.ok) continue;
            const hist = await hr.json();
            const outs = hist?.[prompt_id]?.outputs;
            if (!outs) continue; // 排队中
            const img = outs?.['9']?.images?.[0];
            if (img) {
                const vr = await fetch(base + '/view?filename=' + encodeURIComponent(img.filename) +
                    '&subfolder=' + encodeURIComponent(img.subfolder || '') +
                    '&type=' + encodeURIComponent(img.type || 'output'),
                    { signal: timeoutSignal(30000) });
                if (!vr.ok) throw new Error('view ' + vr.status);
                const blob = await vr.blob();
                const url = URL.createObjectURL(blob);
                _imgCache.set(key, url);
                _lastGood.base = base;
                _lastGood.ts = Date.now();
                return { url, model, base };
            }
            if (hist[prompt_id].status?.completed) throw new Error('gen failed');
        }
        throw new Error('timeout');
    } catch (e) {
        console.warn('[VN-Lite] CG 生成失败于 ' + base + '：', e.message);
        _modelCache.list = null;
        _modelCache.base = null;
        return null;
    }
}

// ---------- 主入口 ----------
// 返回 { url } 或 null（任何失败均静默降级）
async function generateCG(prompt, S) {
    if (!/^[a-zA-Z0-9]/.test(prompt)) {
        // 中文提示词：SD 不认识，直接降级，避免浪费一次生成
        return null;
    }

    const bases = candidateBases(S).slice(0, 4); // 避免离线时探测太久
    for (const base of bases) {
        const result = await tryGenerateOn(base, prompt, S);
        if (result) return result;
    }
    console.warn('[VN-Lite] CG 生成失败：所有候选 ComfyUI 地址均不可用（可用「自动探测」重新选地址）');
    return null;
}

// 连通性测试（设置面板按钮用）：详细结果对象
async function testConnection(S, ms = 8000) {
    const base = baseURL(S);
    if (!base) return { ok: false, base: '', reason: '请先填写 ComfyUI 地址' };
    const res = await probeBase(base, ms);
    if (res.ok) {
        _lastGood.base = res.base;
        _lastGood.ts = Date.now();
    }
    return res;
}

export {
    generateCG,
    testConnection,
    detectComfyUI,
    probeBase,
    candidateBases,
    baseURL,
};
