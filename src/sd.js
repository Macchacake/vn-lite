// ============================================
// sd.js — ComfyUI API 客户端（本地/局域网绘画）
// 流程：/object_info 选模型 → /prompt 提交 →
//       /history 轮询 → /view 取图 → 缓存返回
// 全部失败返回 null（调用方降级内置素材，不卡演出）
// ============================================

const CLIENT_ID = 'vn-lite-' + Math.random().toString(36).slice(2, 10);
const _modelCache = { list: null, ts: 0 };
const _imgCache = new Map(); // prompt -> objectURL（同提示词复用）

function baseURL(S) {
    let u = (S.sdUrl || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u;
}

// ---------- 模型列表 ----------
async function listModels(base) {
    // 缓存 5 分钟，避免每次绘图都查询
    if (_modelCache.list && Date.now() - _modelCache.ts < 300000) return _modelCache.list;
    const r = await fetch(base + '/object_info/CheckpointLoaderSimple', { signal: timeoutSignal(8000) });
    if (!r.ok) throw new Error('object_info ' + r.status);
    const j = await r.json();
    const arr = j?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    if (!Array.isArray(arr) || !arr.length) throw new Error('no checkpoints');
    _modelCache.list = arr; _modelCache.ts = Date.now();
    return arr;
}

function pickModel(models) {
    return models.find(m => /animagine/i.test(m))
        || models.find(m => /xl/i.test(m))
        || models.find(m => /anything/i.test(m))
        || models[0];
}

function timeoutSignal(ms) {
    if (typeof AbortController === 'undefined') return undefined;
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
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

// ---------- 主入口 ----------
// 返回 { url } 或 null（任何失败均静默降级）
async function generateCG(prompt, S) {
    const base = baseURL(S);
    if (!base) return null;
    if (!/^[a-zA-Z0-9]/.test(prompt)) {
        // 中文提示词：SD 不认识，直接降级，避免浪费一次生成
        return null;
    }
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

        // 轮询 history（最长 ~4 分钟，RTX4060 生成 SDXL 约 10~30 秒）
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
                return { url, model };
            }
            // outputs 存在但无图且状态完成 → 失败
            if (hist[prompt_id].status?.completed) throw new Error('gen failed');
        }
        throw new Error('timeout');
    } catch (e) {
        console.warn('[VN-Lite] CG 生成失败（降级内置素材）:', e.message);
        // 失败清模型缓存，下次重新探测
        _modelCache.list = null;
        return null;
    }
}

// 连通性测试（设置面板按钮用）：返回模型名或 null
async function testConnection(S) {
    const base = baseURL(S);
    if (!base) return null;
    try {
        const models = await listModels(base);
        return pickModel(models);
    } catch { return null; }
}

export { generateCG, testConnection };
