// ============================================
// art.js — 美术总监：自动生图 / 预生成 / 素材缓存
// 背景、立绘、物品图标、CG 全部走 ComfyUI，
// 生成结果按 (kind,key) 缓存，持久化在设置里，
// 下次同一场景/角色/物品直接复用，不再重复生成。
// ============================================

import { generateCG, hasMatte, candidateBases } from './sd.js';
import { addToGallery } from './gallery.js';
import { save as saveSettings } from './settings.js';
import { styleOf, SIZE, joinTags, stripBgTags, DEFAULT_PORTRAIT_TPL, DEFAULT_ITEM_TPL } from './styles.js';
import { clearChromaCache } from './chroma.js';
import * as localstore from './localstore.js';
import { scoped, getChatKey } from './session.js';

let S = null;                       // 当前设置对象（引用，实时生效）
const queue = [];                   // 待生成队列
const queued = new Set();           // kind|key 去重
let running = false;
const listeners = new Set();

// 素材缓存版本：改了提示词结构 / 出图尺寸 / 透明底做法就 +1，
// 旧图会整体作废，避免用户看到上一版留下的废图。
const ART_VER = 6;   // v6: 素材按对话隔离 + 图片下载到手机本地（IndexedDB）

export function init(settings) {
    S = settings;
    if (S && S.artVer !== ART_VER) {
        S.artCache = { bg: {}, char: {}, item: {}, cg: {} };
        S.gallery = [];
        S.artVer = ART_VER;
        saveSettings();
        console.log('[VN-Lite] 素材缓存已按新版本重建');
    }
    refreshMatte();
}

// 探测服务端有没有抠图能力：有的话立绘改用中性灰幕布（不会溢色），
// 没有就只能绿幕 + 前端抠色。
// 注意：和出图一样要走「多地址」逻辑 —— 手机可能通过 USB 转发、
// 局域网、Tailscale 三种方式连到同一台 ComfyUI，只探 sdUrl 会误判。
export async function refreshMatte() {
    if (!S) return false;
    let ok = false;
    try {
        if (S.sdOn) {
            const bases = candidateBases(S).slice(0, 4);
            for (const b of bases) {
                if (await hasMatte(b)) { ok = true; break; }
            }
        }
    } catch (e) { ok = false; }
    if (S._matteOk !== ok) {
        S._matteOk = ok;
        // 幕布做法变了，旧立绘得重画
        if (S.artCache && S.artCache.char) S.artCache.char = {};
        saveSettings();
        console.log('[VN-Lite] 服务端抠图' + (ok ? '可用，立绘改用中性灰幕布' : '不可用，退回绿幕抠色'));
    }
    return ok;
}

export function matteOk() { return !!(S && S._matteOk); }

export function onReady(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit(kind, key, url) {
    for (const fn of listeners) {
        try { fn(kind, key, url); } catch (e) { /* 忽略单个监听器异常 */ }
    }
}

// ---------- 缓存 ----------
function cacheOf(kind) {
    if (!S) return {};
    if (!S.artCache || typeof S.artCache !== 'object') S.artCache = {};
    if (!S.artCache[kind] || typeof S.artCache[kind] !== 'object') S.artCache[kind] = {};
    return S.artCache[kind];
}

export function viewUrl(rec) {
    if (!rec || !rec.filename) return null;
    // 本地优先：图已经下载到手机，直接给 blob URL。隧道关掉、ComfyUI 关掉、
    // 换了公网地址，图都还在。localId 是按对话隔离的稳定 key。
    const localId = rec.localId || (rec.kind && rec.key ? scoped(rec.kind + '|' + rec.key) : null);
    const local = localId ? localstore.peekUrl(localId) : null;
    if (local) return local;
    return remoteUrl(rec);
}

// 远程地址（ComfyUI /view）：本地没有副本时用。
function remoteUrl(rec) {
    // 缓存里记的是生成当时的 base。trycloudflare 每次重启都会换域名，
    // 旧 base 一失效，图就全变白/黑。这里在取图时实时换到当前 sdUrl：
    // 图片文件还在同一台 ComfyUI 上，只要 base 指向它就能取回。
    let base = rec.base;
    const cur = String((S && S.sdUrl) || '').replace(/\/+$/, '');
    if (cur && base && base !== cur) {
        // 只在「旧地址是隧道 / 本机地址」时迁移，避免把用户手动指向别处的图也改掉
        const isTunnelish = /trycloudflare\.com|localhost|127\.0\.0\.1|:\d{4,5}/i.test(base);
        if (isTunnelish) base = cur;
    }
    if (!base) return null;
    return base + '/view?filename=' + encodeURIComponent(rec.filename) +
        '&subfolder=' + encodeURIComponent(rec.subfolder || '') +
        '&type=' + encodeURIComponent(rec.type || 'output');
}

export function peek(kind, key) {
    if (!S) return null;
    const bucket = cacheOf(kind);
    // 先查当前对话（带前缀），再查无前缀的旧缓存（兼容升级前的记录）
    const rec = bucket[scoped(key)] || bucket[key];
    return rec ? viewUrl(rec) : null;
}

function store(kind, key, res, prompt) {
    // 素材 key 带上当前对话前缀 → 不同对话的同名场景/角色各存各的
    const scopedKey = scoped(key);
    const localId = scoped(kind + '|' + key);
    const rec = {
        base: res.base, filename: res.filename,
        subfolder: res.subfolder || '', type: res.type || 'output',
        localId,
        chat: getChatKey(),
        storedAt: Date.now(),
    };
    const m = cacheOf(kind);
    m[scopedKey] = rec;
    // 简单上限，避免设置文件无限膨胀
    const keys = Object.keys(m);
    if (keys.length > 240) for (const k of keys.slice(0, keys.length - 240)) delete m[k];
    saveSettings();
    addToGallery({ kind, key, prompt, ...rec });
    emit(kind, key, viewUrl(rec));

    // 后台把图下载到手机本地（不阻塞演出）。失败也没关系，退回远程地址。
    const remote = remoteUrl(rec);
    if (remote) {
        localstore.saveFromUrl(localId, remote, { kind, key, prompt, chatId: getChatKey() })
            .then(() => emit(kind, key, viewUrl(rec)))  // 下载完成 → 舞台换成 blob URL
            .catch(() => { /* 静默降级：继续用远程地址 */ });
    }
}

// ---------- 提示词模板 ----------
const SCENE_PROMPT = {
    '室内': 'cozy room interior, warm lamp light, wooden furniture, soft shadows',
    '教室': 'empty classroom, blackboard, rows of desks, afternoon light through windows',
    '走廊': 'school hallway, long corridor, lockers, soft daylight',
    '操场': 'school sports field, running track, blue sky, distant trees',
    '校园': 'school campus, trees, path, clear sky, peaceful',
    '街道': 'city street at night, neon signs, wet pavement reflections',
    '商店': 'small convenience store interior, shelves of goods, fluorescent light',
    '餐厅': 'warm restaurant interior, tables, hanging lamps, cozy',
    '咖啡馆': 'cozy cafe interior, wooden tables, window light, plants',
    '卧室': 'bedroom, bed with soft blanket, window, warm dim light',
    '客厅': 'living room, sofa, coffee table, soft ambient light',
    '浴室': 'bathroom, tiles, steam, soft blue light',
    '厨房': 'home kitchen, counter, pots, warm light',
    '办公室': 'modern office, desks, computers, large windows, daylight',
    '森林': 'deep forest, tall trees, shafts of sunlight through leaves',
    '山路': 'mountain path, rocky trail, distant peaks, clear sky',
    '海边': 'seaside beach, ocean waves, golden sunlight, horizon',
    '河边': 'riverside, calm water, grass bank, soft morning light',
    '雪地': 'snow field, falling snow, pale blue light, quiet',
    '夜空': 'night sky, stars, moon, silhouette of landscape',
    '雨天': 'rainy street, heavy rain, puddles, grey light',
    '黄昏': 'sunset, warm orange sky, long shadows, silhouettes',
};

// 背景专用画风尾巴：把「画五官」的词摘掉。
// 实测：otome 预设里有 beautiful detailed eyes / elegant，Animagine XL
// 看到这几个词会直接画一张大脸，把「背景」生成成人物特写 —— 手机上那张
// 占满整个舞台的粉发少女就是这么来的，而它本该是宗门东院的场景图。
const BG_FACE_TAGS = new Set([
    'beautiful detailed eyes', 'large expressive eyes', 'detailed eyes',
    'detailed skin', 'elegant', 'romantic atmosphere', '1girl', '1boy',
    'glossy hair', 'tall proportions',
]);

function bgTail() {
    return String(styleOf(S).tail || '')
        .split(',')
        .map(t => t.trim())
        .filter(t => t && !BG_FACE_TAGS.has(t.toLowerCase()))
        .join(', ');
}

// 中文场景词 → 英文背景标签。
// 踩过的坑：角色卡写的是 [scene:某宗门·外门东院] 这种中文专有名词，
// 而 SCENE_PROMPT 只有「教室 / 街道 / 咖啡馆」这些现代场景，
// 查不到就退化成 "anime background art, detailed scenery"，
// 于是仙侠屋里画出了欧式石砌教堂 + 齿轮，和剧情完全对不上。
const SCENE_KW_EN = [
    [/(戒律|刑堂|刑坪|牢|狱|石室|执法|禁地)/, 'ancient chinese stone hall, cold stone walls, iron chains, dim torchlight, ominous atmosphere, xianxia'],
    [/(药堂|药房|丹房|药庐|药炉|炼丹|百草)/, 'ancient chinese herbal medicine hall, wooden shelves, porcelain jars, incense smoke, warm lantern light, xianxia'],
    [/(卷宗|书阁|藏书|剑阁|藏经|书房|典籍|宗阁)/, 'ancient chinese library, tall wooden shelves, scrolls, paper lanterns, dust motes in light beams, xianxia'],
    [/(庭院|院子|院|回廊|廊|檐|厢房)/, 'ancient chinese courtyard, wooden veranda, stone paving, bamboo, paper lanterns, xianxia'],
    [/(屋|房|室内|密室|主宅|宅|室|榻|床|卧|寝室|内室)/, 'ancient chinese room interior, wooden lattice window, low table, canopy bed, dim candlelight, xianxia'],
    [/(竹林|竹)/, 'bamboo forest, tall green bamboo, dappled sunlight, mist, xianxia'],
    [/(山|峰|崖|谷|岭|云海|主峰)/, 'mountain landscape, rocky peaks, sea of clouds, pine trees, chinese ink wash mood, xianxia'],
    [/(湖|河|溪|潭|池|渡口|水)/, 'calm water, river bank, reeds, soft mist, reflection, xianxia'],
    [/(街|坊市|集市|酒馆|客栈|茶楼|摊)/, 'ancient chinese street, wooden shopfronts, hanging banners, red lanterns, xianxia'],
    [/(宗|殿|阁|堂|门|寺|观|庙|府|楼|斋|轩|居)/, 'ancient chinese architecture, temple hall, tiled curved roofs, red pillars, stone steps, xianxia'],
    [/(夜|月|星)/, 'night, moonlight, dark blue tones'],
    [/(雪|冬|寒)/, 'snow, falling snow, pale cold light'],
    [/(雨|阴|雾)/, 'rain, wet stone, grey misty light'],
    [/(血|战|杀|伤|鞭|尸)/, 'dark atmosphere, dust and smoke, dramatic rim light'],
];

export function scenePrompt(cat) {
    const key = String(cat || '').trim();
    let base = SCENE_PROMPT[key];
    if (!base) {
        // 没命中预设表：按中文关键词拼英文标签（最多 3 组，避免提示词打架）
        const tags = [];
        for (const [re, en] of SCENE_KW_EN) {
            if (re.test(key) && !tags.includes(en)) tags.push(en);
            if (tags.length >= 3) break;
        }
        base = tags.length ? tags.join(', ') : 'anime background art, detailed scenery';
    }
    // 「no people / 纯场景」放在最前面，权重最高；画风尾巴用去人脸版本。
    return joinTags([
        'scenery only, pure background, no people, no humans, no character, no face, no figure',
        base,
        'no people, anime background art, highly detailed',
        bgTail(),
    ]);
}

// 抠色专用的幕布描述：要「纯色、均匀、无渐变」，否则 flood fill 会被
// 渐变和光晕带跑，边缘必然发毛。
const KEY_SPEC = {
    green: 'flat pure green background, solid chroma key green, uniform #00FF00 backdrop, completely flat color, no gradient',
    blue: 'flat pure blue background, solid chroma key blue, uniform #0000FF backdrop, completely flat color, no gradient',
    magenta: 'flat pure magenta background, solid chroma key magenta, uniform #FF00FF backdrop, completely flat color, no gradient',
};

// 有服务端 AI 抠图时用中性灰：灰幕布不会被头发/裙子吃进去，
// 抠出来不会有一圈绿边（绿幕再怎么 despill 也救不干净半透明发梢）。
const GREY_SPEC = 'flat medium grey background, solid grey backdrop, completely flat color, no gradient';

function alphaOn() { return !!(S && S.portraitAlpha); }

export function charPrompt(name) {
    let tpl = (S && S.portraitTpl) || DEFAULT_PORTRAIT_TPL;
    const hint = (S && S.artPrompts && S.artPrompts[name]) || '';
    const st = styleOf(S);
    let tail = st.tail;
    let bgTag = '';
    if (alphaOn()) {
        // 抠图时：摘掉会画背景的标签，再补一条纯色幕布要求。
        tail = stripBgTags(tail);
        tpl = tpl.replace(/simple background,?\s*/gi, '');
        // 「opaque hair」很关键：AI 画飘逸长发时会把它画成半透明，
        // 幕布颜色从头发里透出来，抠完之后头发是绿的，怎么修都救不回来。
        const spec = matteOk() ? GREY_SPEC : (KEY_SPEC[S.portraitKey] || KEY_SPEC.green);
        bgTag = spec + ', opaque solid hair, fully opaque clothing';
    }
    // 顺序 = 权重：构图 > 外观 > 幕布 > 画风
    // 构图必须排第一，否则模型容易只顾画脸不管全身；外观紧跟其后保证像本人。
    return joinTags([tpl, hint, bgTag, tail]);
}

export function charNeg(name) {
    const st = styleOf(S);
    const parts = [st.preset.neg];
    if (alphaOn()) {
        // 全身立绘最容易被裁的就是脚，这几个词是实测下来最管用的
        parts.push('cowboy shot, upper body, close-up, portrait, cropped legs, cut off feet, out of frame');
        parts.push('detailed background, scenery, gradient background, multiple views, multiple characters');
        // 这些会把幕布画脏，是抠图失败的头号原因
        parts.push('vignette, glow, backlighting, light rays, soft focus, depth of field, gradient, noise, texture, drop shadow, reflection');
        parts.push('translucent hair, transparent hair, see-through hair, glass hair, semi-transparent clothing');
    }
    return parts.filter(Boolean).join(', ');
}

export function itemPrompt(name) {
    const tpl = (S && S.itemTpl) || DEFAULT_ITEM_TPL;
    const hint = (S && S.artPrompts && S.artPrompts[name]) || '';
    return joinTags([tpl, hint, styleOf(S).tail]);
}

// 立绘是否要求透明底（供 stage 决定是否加描边/投影）
export function portraitAlpha() { return alphaOn(); }

// ---------- 队列 ----------
// 稳定种子：同一个角色 / 场景 / 物品永远拿到同一个种子，
// 这样反复重画也是同一张脸，不会「每次都是另一个人」。
function hashSeed(str) {
    let h = 2166136261 >>> 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

export function ensure(kind, key, prompt, opts = {}) {
    if (!S || !key || !prompt) return false;
    if (!S.sdOn || !S.autoArt) return false;
    if (peek(kind, key)) return false;
    const id = kind + '|' + key;
    if (queued.has(id)) return false;
    queued.add(id);
    const size = opts.size || SIZE[kind] || SIZE.cg;
    queue.push({
        kind, key, prompt,
        priority: opts.priority ? 1 : 0,
        opts: {
            w: size[0], h: size[1],
            negative: opts.negative || '',
            transparent: !!opts.transparent,
            keyColor: opts.keyColor || 'green',
            seed: hashSeed(kind + '|' + key),
        },
    });
    pump();
    return true;
}

function takeNext() {
    // 优先级高的先出（CG/当前场景）
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].priority > queue[best].priority) best = i;
    return queue.splice(best, 1)[0];
}

async function pump() {
    if (running || !queue.length) return;
    if (!S || !S.sdOn || !S.autoArt) { queue.length = 0; queued.clear(); return; }
    running = true;
    const job = takeNext();
    try {
        const res = await generateCG(job.prompt, S, job.opts || {});
        if (res && res.base && res.filename) {
            store(job.kind, job.key, res, job.prompt);
        } else {
            console.warn('[VN-Lite] 生图失败：', job.kind, job.key);
        }
    } catch (e) {
        console.warn('[VN-Lite] 生图异常：', e && e.message);
    } finally {
        queued.delete(job.kind + '|' + job.key);
        running = false;
        if (queue.length) setTimeout(pump, 120);
    }
}

// ---------- 剧本预扫描 ----------
// 把这一幕里出现的场景 / 角色 / 物品排进队列，提前把图生好
export function prefetch(script) {
    if (!S || !S.sdOn || !S.autoArt || !S.preGen) return 0;
    const max = Math.max(0, Math.min(10, Number(S.preGenMax) || 3));
    let added = 0;
    const seen = new Set();

    const wantChar = (name) => {
        if (added >= max) return;
        if (seen.has('char' + name)) return;
        seen.add('char' + name);
        if (peek('char', name)) return;
        // 没有外观标签就别画：模型不知道这是谁，只会随机编一个人出来。
        // 真机上「白发男主画成粉发少女」就是这么来的。
        // 这时先让舞台用角色卡头像/剪影顶着，等 index.js 把外观标签
        // 生成好（或用户手填）再重画。
        if (!(S.artPrompts && S.artPrompts[name])) return;
        if (ensure('char', name, charPrompt(name), {
            negative: charNeg(name),
            size: SIZE.char,
            transparent: alphaOn(),
            keyColor: S.portraitKey,
        })) added++;
    };
    const wantBg = (cat) => {
        if (added >= max) return;
        if (seen.has('bg' + cat)) return;
        seen.add('bg' + cat);
        if (peek('bg', cat)) return;
        if (ensure('bg', cat, scenePrompt(cat), { size: SIZE.bg })) added++;
    };
    const wantItem = (name) => {
        if (added >= max) return;
        if (seen.has('item' + name)) return;
        seen.add('item' + name);
        if (peek('item', name)) return;
        if (ensure('item', name, itemPrompt(name), { size: SIZE.item })) added++;
    };

    for (const seg of script.segments || []) {
        if (seg.t === 'dir' && seg.scene) wantBg(seg.scene);
        if (seg.t === 'dir' && seg.char && seg.char.name) wantChar(seg.char.name);
        if ((seg.t === 'say' || seg.t === 'inner') && seg.who) wantChar(seg.who);
        if (seg.t === 'item' && seg.name) wantItem(seg.name);
        if (added >= max) break;
    }
    // 背景优先级最高：先把场景铺好
    for (const job of queue) if (job.kind === 'bg') job.priority = 2;
    pump();
    return added;
}

// ---------- CG（按需） ----------
export async function cg(prompt) {
    if (!prompt) return null;
    const hit = peek('cg', prompt);
    if (hit) return { url: hit };
    if (!S || !S.sdOn) return null;
    const res = await generateCG(prompt, S, { w: SIZE.cg[0], h: SIZE.cg[1], negative: styleOf(S).preset.neg });
    if (!res) return null;
    if (res.base && res.filename) store('cg', prompt, res, prompt);
    return { url: res.url };
}

// 切换/初始化对话时调用：把这段对话的本地图从 IndexedDB 重建为 objectURL，
// 然后通知舞台用本地地址重画（远程地址失效时这段尤其重要）。
export function hydrateChat() {
    return localstore.hydrate(getChatKey()).then(() => {
        if (!S || !S.artCache) return;
        for (const kind of ['bg', 'char', 'item', 'cg']) {
            const bucket = S.artCache[kind] || {};
            for (const [k, rec] of Object.entries(bucket)) {
                if (!rec) continue;
                const rawKey = k.includes('::') ? k.slice(k.indexOf('::') + 2) : k;
                emit(kind, rawKey, viewUrl(rec));
            }
        }
    }).catch(() => { /* 本地存储不可用时忽略 */ });
}

export function stats() {
    const c = (S && S.artCache) || {};
    return {
        bg: Object.keys(c.bg || {}).length,
        char: Object.keys(c.char || {}).length,
        item: Object.keys(c.item || {}).length,
        cg: Object.keys(c.cg || {}).length,
        queue: queue.length,
        running,
    };
}

export function clearCache(kind, withLocal = false) {
    if (!S) return;
    if (!S.artCache) S.artCache = {};
    if (kind) S.artCache[kind] = {};
    else S.artCache = { bg: {}, char: {}, item: {}, cg: {} };
    try { clearChromaCache(); } catch (e) { /* 抠色缓存清不掉也不影响 */ }
    saveSettings();
    if (withLocal) {
        try { localstore.clearChat(getChatKey()); } catch (e) { /* 忽略 */ }
    }
}
