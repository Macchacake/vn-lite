// ============================================
// styles.js — 画风预设 / 出图尺寸 / 性别标签
// 只靠提示词实现，不依赖 LoRA，装上就能用。
// 标签尽量用 Danbooru 体系（Animagine 系列吃这套）。
// ============================================

export const STYLE_PRESETS = {
    otome: {
        label: '乙女向（女性向恋爱游戏）',
        desc: '细腻描边 + 柔光 + 闪粉，男性角色清秀俊美',
        tail: 'delicate lineart, soft gradient shading, pastel color palette, sparkle, floating particles, bokeh, backlighting, romantic atmosphere, beautiful detailed eyes, elegant',
        neg: 'harsh shadows, gritty, muscular, ugly, deformed',
    },
    shoujo: {
        label: '少女漫（网点漫画）',
        desc: '网点、速度线、大眼睛、高对比描边',
        tail: 'shoujo, manga style, screentone, halftone, speed lines, large expressive eyes, thick lineart, high contrast, flower motif, sparkle',
        neg: 'photorealistic, 3d, cgi',
    },
    cel: {
        label: '赛璐璐动画（番剧截图）',
        desc: '平涂、清晰描边、颜色鲜艳，像 TV 动画截图',
        tail: 'cel shading, flat color, clean lineart, anime screencap, vibrant colors, sharp shadows, tv anime, official art',
        neg: 'painterly, sketch, rough lines',
    },
    webtoon: {
        label: '韩系条漫（网漫）',
        desc: '干净线稿 + 渐变上色，韩式乙女漫常见画法',
        tail: 'webtoon style, manhwa, clean lineart, soft cel shading, gradient shading, glossy hair, tall proportions, romance comic, detailed eyes',
        neg: 'chibi, rough sketch',
    },
    painterly: {
        label: '厚涂（半写实）',
        desc: '笔触厚重、光影戏剧化，偏概念设定图',
        tail: 'painterly, thick brush strokes, semi-realistic, detailed skin, dramatic lighting, rich colors, chiaroscuro, concept art',
        neg: 'flat color, cel shading, chibi',
    },
    watercolor: {
        label: '水彩（轻小说插画）',
        desc: '水彩晕染、纸纹、色调柔和',
        tail: 'watercolor (medium), soft washes, paper texture, light novel illustration, gentle colors, wet on wet, blooming, soft edges',
        neg: 'harsh lines, neon, 3d',
    },
    gothic: {
        label: '暗黑哥特',
        desc: '低饱和、深阴影、血色点缀，适合悬疑/吸血鬼题材',
        tail: 'dark fantasy, gothic, moody lighting, deep shadows, desaturated, crimson accent, ornate, elegant, dramatic, chiaroscuro',
        neg: 'bright pastel, cheerful, chibi',
    },
    retro: {
        label: '复古 90 年代动画',
        desc: '颗粒感、褪色调、老动画质感',
        tail: 'retro artstyle, 1990s (style), film grain, muted colors, vintage anime, soft vignette, retro color palette',
        neg: 'modern digital, glossy, 3d',
    },
};

export const DEFAULT_STYLE = 'otome';

export function styleOf(S) {
    const id = (S && S.stylePreset) || DEFAULT_STYLE;
    const p = STYLE_PRESETS[id] || STYLE_PRESETS[DEFAULT_STYLE];
    const custom = S && S.artStyle ? String(S.artStyle).trim() : '';
    return { id: STYLE_PRESETS[id] ? id : DEFAULT_STYLE, preset: p, tail: [p.tail, custom].filter(Boolean).join(', ') };
}

// 拼提示词：去重、去空、统一逗号分隔
export function joinTags(list) {
    const seen = new Set();
    const out = [];
    for (const part of list) {
        if (!part) continue;
        for (const raw of String(part).split(',')) {
            const t = raw.trim();
            if (!t) continue;
            const k = t.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(t);
        }
    }
    return out.join(', ');
}

// 这些标签会「往背景上加东西」（闪粉、光晕、花瓣、景深），
// 抠透明底时必须摘掉，否则绿幕会被盖住，抠不干净。
export const BG_TAGS = new Set([
    'sparkle', 'floating particles', 'bokeh', 'backlighting', 'romantic atmosphere',
    'lens flare', 'glow', 'halo', 'flower petals', 'cherry blossoms', 'petals',
    'gradient background', 'detailed background', 'scenery', 'light rays', 'sunburst',
    'vignette', 'depth of field', 'blurry background', 'flower motif', 'screentone',
    'halftone', 'speed lines', 'film grain', 'paper texture', 'soft vignette',
    'wet on wet', 'blooming', 'soft edges', 'soft washes', 'gradient shading',
]);

export function stripBgTags(tail) {
    return String(tail || '')
        .split(',')
        .map(t => t.trim())
        .filter(t => t && !BG_TAGS.has(t.toLowerCase()))
        .join(', ');
}

// 出图尺寸（Animagine XL 官方推荐比例）
export const SIZE = {
    char: [768, 1344],   // 4:7 竖长条 —— 全身立绘
    bg: [1216, 832],     // 3:2 横图
    item: [1024, 1024],  // 1:1 图标
    cg: [1216, 832],
};

// 立绘提示词模板（默认全身）
// 注意：不要写 portrait / close-up / face focus —— 这几个词会把构图拉回头肩像，
// 实测会生成「一张大脸 + 一个全身小人」的怪图。
// 这串是实测过脚不会被裁、人物约占画面高度 85% 的组合。
export const DEFAULT_PORTRAIT_TPL =
    'wide shot, full body shot, solo, single character, standing, front view, head to toe, ' +
    'full-length figure, feet visible, entire body in frame, shoes visible, looking at viewer';

export const DEFAULT_ITEM_TPL =
    'game item icon, single object, centered, simple dark background, soft rim light';
