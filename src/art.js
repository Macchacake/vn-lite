// ============================================
// art.js — 美术总监：自动生图 / 预生成 / 素材缓存
// 背景、立绘、物品图标、CG 全部走 ComfyUI，
// 生成结果按 (kind,key) 缓存，持久化在设置里，
// 下次同一场景/角色/物品直接复用，不再重复生成。
// ============================================

import { generateCG } from './sd.js';
import { addToGallery } from './gallery.js';
import { save as saveSettings } from './settings.js';
import { styleOf, SIZE, joinTags, stripBgTags, DEFAULT_PORTRAIT_TPL, DEFAULT_ITEM_TPL } from './styles.js';
import { clearChromaCache } from './chroma.js';

let S = null;                       // 当前设置对象（引用，实时生效）
const queue = [];                   // 待生成队列
const queued = new Set();           // kind|key 去重
let running = false;
const listeners = new Set();

// 素材缓存版本：改了提示词结构 / 出图尺寸 / 透明底做法就 +1，
// 旧图会整体作废，避免用户看到上一版留下的废图。
const ART_VER = 4;

export function init(settings) {
    S = settings;
    if (S && S.artVer !== ART_VER) {
        S.artCache = { bg: {}, char: {}, item: {}, cg: {} };
        S.gallery = [];
        S.artVer = ART_VER;
        saveSettings();
        console.log('[VN-Lite] 素材缓存已按新版本重建');
    }
}

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
    if (!rec || !rec.base || !rec.filename) return null;
    return rec.base + '/view?filename=' + encodeURIComponent(rec.filename) +
        '&subfolder=' + encodeURIComponent(rec.subfolder || '') +
        '&type=' + encodeURIComponent(rec.type || 'output');
}

export function peek(kind, key) {
    if (!S) return null;
    const rec = cacheOf(kind)[key];
    return rec ? viewUrl(rec) : null;
}

function store(kind, key, res, prompt) {
    const rec = {
        base: res.base, filename: res.filename,
        subfolder: res.subfolder || '', type: res.type || 'output',
    };
    const m = cacheOf(kind);
    m[key] = rec;
    // 简单上限，避免设置文件无限膨胀
    const keys = Object.keys(m);
    if (keys.length > 240) for (const k of keys.slice(0, keys.length - 240)) delete m[k];
    saveSettings();
    addToGallery({ kind, key, prompt, ...rec });
    emit(kind, key, viewUrl(rec));
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

export function scenePrompt(cat) {
    const base = SCENE_PROMPT[cat] || 'anime background art, detailed scenery';
    return joinTags([base, 'no people, anime background, highly detailed', styleOf(S).tail]);
}

// 抠色专用的幕布描述：要「纯色、均匀、无渐变」，否则 flood fill 会被
// 渐变和光晕带跑，边缘必然发毛。
const KEY_SPEC = {
    green: 'flat pure green background, solid chroma key green, uniform #00FF00 backdrop, completely flat color, no gradient',
    blue: 'flat pure blue background, solid chroma key blue, uniform #0000FF backdrop, completely flat color, no gradient',
    magenta: 'flat pure magenta background, solid chroma key magenta, uniform #FF00FF backdrop, completely flat color, no gradient',
};

function alphaOn() { return !!(S && S.portraitAlpha); }

export function charPrompt(name) {
    let tpl = (S && S.portraitTpl) || DEFAULT_PORTRAIT_TPL;
    const hint = (S && S.artPrompts && S.artPrompts[name]) || '';
    const st = styleOf(S);
    let tail = st.tail;
    let bgTag = '';
    if (alphaOn()) {
        // 抠色时：摘掉会画背景的标签，再补一条纯色幕布要求。
        // 注意顺序：角色外观必须排在最前面（权重最高），否则画出来不像本人。
        tail = stripBgTags(tail);
        tpl = tpl.replace(/simple background,?\s*/gi, '');
        bgTag = KEY_SPEC[S.portraitKey] || KEY_SPEC.green;
    }
    // 顺序 = 权重：外观 > 构图 > 幕布 > 画风
    return joinTags([hint, tpl, bgTag, tail]);
}

export function charNeg(name) {
    const st = styleOf(S);
    const parts = [st.preset.neg];
    if (alphaOn()) {
        parts.push('detailed background, scenery, gradient background, multiple views, multiple characters');
        // 这些会把幕布画脏，是抠图失败的头号原因
        parts.push('vignette, glow, backlighting, light rays, soft focus, depth of field, gradient, noise, texture, drop shadow, reflection');
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
        if (seg.t === 'say' && seg.who) wantChar(seg.who);
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

export function clearCache(kind) {
    if (!S) return;
    if (!S.artCache) S.artCache = {};
    if (kind) S.artCache[kind] = {};
    else S.artCache = { bg: {}, char: {}, item: {}, cg: {} };
    try { clearChromaCache(); } catch (e) { /* 抠色缓存清不掉也不影响 */ }
    saveSettings();
}
