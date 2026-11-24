// ============================================
// art.js — 美术总监：自动生图 / 预生成 / 素材缓存
// 背景、立绘、物品图标、CG 全部走 ComfyUI，
// 生成结果按 (kind,key) 缓存，持久化在设置里，
// 下次同一场景/角色/物品直接复用，不再重复生成。
// ============================================

import { generateCG } from './sd.js';
import { addToGallery } from './gallery.js';
import { save as saveSettings } from './settings.js';

let S = null;                       // 当前设置对象（引用，实时生效）
const queue = [];                   // 待生成队列
const queued = new Set();           // kind|key 去重
let running = false;
const listeners = new Set();

export function init(settings) { S = settings; }

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
    return base + ', no people, anime background, highly detailed, ' + styleTail();
}

export function charPrompt(name) {
    const tpl = (S && S.portraitTpl) || 'anime character portrait, upper body, looking at viewer, detailed face, soft lighting';
    const hint = (S && S.artPrompts && S.artPrompts[name]) || '';
    return [tpl, hint, styleTail()].filter(Boolean).join(', ');
}

export function itemPrompt(name) {
    const tpl = (S && S.itemTpl) || 'game item icon, single object, centered, simple dark background, soft rim light';
    const hint = (S && S.artPrompts && S.artPrompts[name]) || '';
    return [tpl, hint, styleTail()].filter(Boolean).join(', ');
}

function styleTail() {
    return (S && S.artStyle) || 'anime style, detailed, cinematic lighting';
}

// ---------- 队列 ----------
export function ensure(kind, key, prompt, opts = {}) {
    if (!S || !key || !prompt) return false;
    if (!S.sdOn || !S.autoArt) return false;
    if (peek(kind, key)) return false;
    const id = kind + '|' + key;
    if (queued.has(id)) return false;
    queued.add(id);
    queue.push({ kind, key, prompt, priority: opts.priority ? 1 : 0 });
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
        const res = await generateCG(job.prompt, S);
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

    const want = (kind, key, prompt) => {
        if (added >= max) return;
        if (seen.has(kind + key)) return;
        seen.add(kind + key);
        if (peek(kind, key)) return;
        if (ensure(kind, key, prompt)) added++;
    };

    for (const seg of script.segments || []) {
        if (seg.t === 'dir' && seg.scene) want('bg', seg.scene, scenePrompt(seg.scene));
        if (seg.t === 'dir' && seg.char && seg.char.name) want('char', seg.char.name, charPrompt(seg.char.name));
        if (seg.t === 'say' && seg.who) want('char', seg.who, charPrompt(seg.who));
        if (seg.t === 'item' && seg.name) want('item', seg.name, itemPrompt(seg.name));
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
    const res = await generateCG(prompt, S);
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
    saveSettings();
}
