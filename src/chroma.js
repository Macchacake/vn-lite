// ============================================
// chroma.js — 浏览器端抠色（透明底立绘）
// 为什么不用 ComfyUI 的 ImageColorToMask：
//   那个节点是「精确颜色匹配」，而模型画出来的
//   绿幕一定带渐变/光晕/投影，几乎匹配不到；
//   匹配到了也会把人物身上同色像素打穿。
// 这里用「魔棒漫水填充」：从图像边缘取背景色，
// 逐像素向相邻扩散（容忍渐变），遇到人物硬边停下。
// 结果转成 PNG dataURL，直接塞回 <img>。
// ============================================

const cache = new Map();      // url -> dataURL | null
const MAX_CACHE = 24;

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('image load failed'));
        im.src = url;
    });
}

// 取边框一圈出现最多的颜色当背景色（量化到 16 级再投票）
function pickSeed(d, W, H) {
    const buckets = new Map();
    const add = (x, y) => {
        const p = (y * W + x) * 4;
        const r = d[p], g = d[p + 1], b = d[p + 2];
        const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        let e = buckets.get(k);
        if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(k, e); }
        e.n++; e.r += r; e.g += g; e.b += b;
    };
    for (let x = 0; x < W; x += 2) { add(x, 0); add(x, H - 1); }
    for (let y = 0; y < H; y += 2) { add(0, y); add(W - 1, y); }
    let best = null;
    for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
    if (!best) return null;
    return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

function dist2(r1, g1, b1, r2, g2, b2) {
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return dr * dr + dg * dg + db * db;
}

// 核心：漫水填充出 alpha
// 思路：
//   1) 从四条边取背景色，找出它「主色通道」（绿幕=绿、蓝幕=蓝）
//   2) 只有「主色通道明显高于另外两个通道」的像素才允许被吃掉
//      —— 这一条能挡住白衬衫、肤色、黑发，比单纯的距离阈值靠谱得多
//   3) 再叠加相邻像素相似度限制，避免顺着柔边一路渗进人物
function computeAlpha(d, W, H, opts) {
    const seed = pickSeed(d, W, H);
    if (!seed) return null;
    const [sr, sg, sb] = seed;

    // 主色通道：0=R 1=G 2=B
    let dom = 1;
    if (sb > sg && sb > sr) dom = 2;
    else if (sr > sg && sr > sb) dom = 0;
    const o1 = dom === 0 ? 1 : 0;
    const o2 = dom === 2 ? 1 : 2;

    const domMargin = opts.domMargin == null ? 3 : opts.domMargin;   // 主通道要比其它通道高多少
    const stepLim = (opts.stepTolerance || 22) ** 2;                 // 相邻像素最大色差
    const looseLim = 260 ** 2;                                       // 极端安全阀，防止跑飞

    const N = W * H;
    const alpha = new Uint8Array(N).fill(255);
    const seen = new Uint8Array(N);
    const stack = new Int32Array(N);
    let sp = 0;

    const push = (i) => {
        if (seen[i]) return;
        seen[i] = 1;
        stack[sp++] = i;
    };

    const isKey = (p) => {
        const c = [d[p], d[p + 1], d[p + 2]];
        const m = Math.max(c[o1], c[o2]);
        return c[dom] - m >= domMargin;
    };

    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }

    while (sp > 0) {
        const i = stack[--sp];
        const p = i * 4;
        if (!isKey(p)) continue;
        const r = d[p], g = d[p + 1], b = d[p + 2];
        if (dist2(r, g, b, sr, sg, sb) > looseLim) continue;
        alpha[i] = 0;

        const x = i % W, y = (i - x) / W;
        if (y > 0) { const j = i - W; const q = j * 4; if (!seen[j] && dist2(d[q], d[q + 1], d[q + 2], r, g, b) <= stepLim) push(j); }
        if (y < H - 1) { const j = i + W; const q = j * 4; if (!seen[j] && dist2(d[q], d[q + 1], d[q + 2], r, g, b) <= stepLim) push(j); }
        if (x > 0) { const j = i - 1; const q = j * 4; if (!seen[j] && dist2(d[q], d[q + 1], d[q + 2], r, g, b) <= stepLim) push(j); }
        if (x < W - 1) { const j = i + 1; const q = j * 4; if (!seen[j] && dist2(d[q], d[q + 1], d[q + 2], r, g, b) <= stepLim) push(j); }
    }

    // 封闭背景块：漫水填不到的地方（两腿之间的缝隙、手臂和身体的空隙）
    // 只要颜色和背景色几乎一样就一起抠掉。阈值收得很紧，避免误伤人物。
    const pocketLim = 110 * 110;
    for (let i = 0; i < N; i++) {
        if (!alpha[i]) continue;
        const p = i * 4;
        if (isKey(p) && dist2(d[p], d[p + 1], d[p + 2], sr, sg, sb) <= pocketLim) alpha[i] = 0;
    }

    // 填洞：从边缘出发标记「外部透明区」。剩下没被标记的透明像素是被围住的，
    // 分成两类处理：
    //   · 面积很小（< holeMax）→ 是人物身上被误吃出来的小洞（鞋面反光之类），补回不透明
    //   · 面积较大 → 是真的背景（两腿之间的缝隙、手臂和身体的空隙），保持透明
    const holeMax = opts.holeMax == null ? 2600 : opts.holeMax;
    const outside = new Uint8Array(N);
    sp = 0;
    const seedPush = (i) => { if (!alpha[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < W; x++) { seedPush(x); seedPush((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { seedPush(y * W); seedPush(y * W + W - 1); }
    while (sp > 0) {
        const i = stack[--sp];
        const x = i % W, y = (i - x) / W;
        if (y > 0) seedPush(i - W);
        if (y < H - 1) seedPush(i + W);
        if (x > 0) seedPush(i - 1);
        if (x < W - 1) seedPush(i + 1);
    }
    // 收集被围住的透明连通块
    const group = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
        if (alpha[i] || outside[i] || group[i] >= 0) continue;
        const members = [];
        sp = 0;
        group[i] = i;
        stack[sp++] = i;
        while (sp > 0) {
            const j = stack[--sp];
            members.push(j);
            const x = j % W, y = (j - x) / W;
            const add = (k) => {
                if (!alpha[k] && !outside[k] && group[k] < 0) { group[k] = i; stack[sp++] = k; }
            };
            if (y > 0) add(j - W);
            if (y < H - 1) add(j + W);
            if (x > 0) add(j - 1);
            if (x < W - 1) add(j + 1);
        }
        // 面积小的封闭透明块 = 人物身上被误吃出来的小洞（裙褶阴影、鞋面反光之类），补回不透明。
        // 面积大的才是真背景缝隙（两腿之间、发丝之间的空隙），保持透明。
        if (members.length <= holeMax) for (const j of members) alpha[j] = 255;
    }

    // 边缘去色边：贴着透明区、且仍然是主色通道占优的像素一并抠掉
    const kill = [];
    for (let i = 0; i < N; i++) {
        if (!alpha[i]) continue;
        const x = i % W, y = (i - x) / W;
        let near = false;
        if (x > 0 && !alpha[i - 1]) near = true;
        else if (x < W - 1 && !alpha[i + 1]) near = true;
        else if (y > 0 && !alpha[i - W]) near = true;
        else if (y < H - 1 && !alpha[i + W]) near = true;
        if (!near) continue;
        const p = i * 4;
        if (isKey(p) && dist2(d[p], d[p + 1], d[p + 2], sr, sg, sb) <= 120 * 120) kill.push(i);
    }
    for (const i of kill) alpha[i] = 0;

    // 边界处理（两遍，覆盖 2px 的过渡带）：
    //   1) 柔化：紧贴透明区、颜色还带背景色的像素，按「带多少背景色」给半透明
    //      —— 原图边缘本来就是抗锯齿混色，一刀切成不透明会留下彩色描边
    //   2) 去色溢：把主色通道压到不超过另外两个通道，绿光反射的染色就没了
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < N; i++) {
            if (!alpha[i]) continue;
            const x = i % W, y = (i - x) / W;
            let near = false;
            if (x > 0 && !alpha[i - 1]) near = true;
            else if (x < W - 1 && !alpha[i + 1]) near = true;
            else if (y > 0 && !alpha[i - W]) near = true;
            else if (y < H - 1 && !alpha[i + W]) near = true;
            if (!near) continue;
            const p = i * 4;
            const c = [d[p], d[p + 1], d[p + 2]];
            const cap = Math.max(c[o1], c[o2]);
            const spill = c[dom] - cap;
            if (spill > 0) {
                const a = Math.max(0, Math.min(255, Math.round(255 * (1 - spill / 34))));
                if (a < alpha[i]) alpha[i] = a;
                c[dom] = cap;
                d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2];
            }
        }
    }

    return alpha;
}

async function compute(url, opts) {
    const im = await loadImage(url);
    const W = im.naturalWidth || im.width;
    const H = im.naturalHeight || im.height;
    if (!W || !H) return null;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0);
    let imgData;
    try {
        imgData = ctx.getImageData(0, 0, W, H);   // CORS 没开的话这里会抛
    } catch (e) {
        console.warn('[VN-Lite] 抠色失败：图片跨域且未开 CORS，保留原图', e && e.message);
        return null;
    }
    const d = imgData.data;
    const alpha = computeAlpha(d, W, H, opts || {});
    if (!alpha) return null;
    for (let i = 0; i < alpha.length; i++) d[i * 4 + 3] = alpha[i];
    ctx.putImageData(imgData, 0, 0);
    try {
        return cv.toDataURL('image/png');
    } catch (e) {
        return null;
    }
}

// 对外：拿到抠好的 dataURL（带缓存），失败返回 null
export async function keyedUrl(url, opts) {
    if (!url) return null;
    if (cache.has(url)) return cache.get(url);
    let out = null;
    try { out = await compute(url, opts); } catch (e) {
        console.warn('[VN-Lite] 抠色异常', e && e.message);
    }
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(url, out);
    return out;
}

// 对外：直接把抠好的图换到 <img> 上（异步，不阻塞演出）
export function applyChroma(img, url, opts) {
    if (!img || !url) return;
    keyedUrl(url, opts).then(keyed => {
        if (!keyed) return;
        if (!img.isConnected) return;
        img.src = keyed;
    });
}

export function clearChromaCache() { cache.clear(); }

// 供测试使用
export { computeAlpha, pickSeed };
