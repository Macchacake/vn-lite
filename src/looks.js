// ============================================
// looks.js — 从角色卡描述里直接抽取外观标签（离线兜底）
// 背景：自动补外观原本全靠 LLM（generateQuietPrompt），
// 手机端酒馆接口一变 / 没配 API，这一步就失败 →
// artPrompts 空 → prefetch 的「没标签不画」让所有角色变剪影。
// 角色卡里其实大多写了「17 male 白半长发 绿眼」这类信息，
// 这里直接抽成 Danbooru 标签，LLM 没跑通也能出立绘。
// ============================================

// 中文发色 → 英文
const HAIR_ZH = [
    [/白(?:色|半长|长|短)?发|银(?:白|色)?发|白发|银发/, 'white hair'],
    [/黑(?:色)?(?:半长|长|短)?发|乌发|墨发/, 'black hair'],
    [/金发|黄金发|金黄色头发/, 'blonde hair'],
    [/棕发|褐发|栗发|茶发/, 'brown hair'],
    [/红发|赤发|朱发/, 'red hair'],
    [/蓝发/, 'blue hair'],
    [/紫发|紫罗兰发/, 'purple hair'],
    [/灰发|银灰发/, 'grey hair'],
    [/粉发|粉红发|桃发/, 'pink hair'],
    [/绿发|青发/, 'green hair'],
];
// 英文发色（角色卡常混写）
const HAIR_EN = [
    [/\b(?:white|silver|platinum)\s+hair\b/i, 'white hair'],
    [/\bblack hair\b/i, 'black hair'],
    [/\bblonde\b|\bgolden hair\b/i, 'blonde hair'],
    [/\bbrown hair\b|\bbrunette\b/i, 'brown hair'],
    [/\bred hair\b/i, 'red hair'],
    [/\bblue hair\b/i, 'blue hair'],
    [/\bpurple hair\b|\bviolet hair\b/i, 'purple hair'],
    [/\bpink hair\b/i, 'pink hair'],
    [/\bgreen hair\b/i, 'green hair'],
];
// 瞳色
const EYE = [
    [/绿眸|绿眼|绿瞳|绿(?:色)?眼睛/i, 'green eyes'],
    [/蓝眸|蓝眼|蓝瞳|蓝(?:色)?眼睛/i, 'blue eyes'],
    [/红眸|红眼|红瞳|红(?:色)?眼睛/i, 'red eyes'],
    [/金眸|金眼|金瞳|金(?:色)?眼睛|琥珀/i, 'amber eyes'],
    [/紫眸|紫眼|紫瞳|紫(?:色)?眼睛/i, 'purple eyes'],
    [/黑眸|黑眼|黑瞳|黑(?:色)?眼睛/i, 'dark eyes'],
    [/\bgreen eyes?\b/i, 'green eyes'],
    [/\bblue eyes?\b/i, 'blue eyes'],
    [/\bred eyes?\b/i, 'red eyes'],
    [/\bamber eyes?\b/i, 'amber eyes'],
    [/\bpurple eyes?\b/i, 'purple eyes'],
];
// 发型 / 长度
const HAIR_STYLE = [
    [/半长发|及肩发|中长发/, 'medium length hair'],
    [/长发|长发及腰|披肩发/, 'long hair'],
    [/短发|齐耳发/, 'short hair'],
    [/双马尾|双辫/, 'twintails'],
    [/马尾/, 'ponytail'],
    [/卷发|波浪发/, 'wavy hair'],
];
// 显著特征
const TRAIT = [
    [/虎牙|尖牙/, 'fangs'],
    [/眼镜/, 'glasses'],
    [/刘海/, 'bangs'],
    [/辫子/, 'braid'],
    [/伤疤|疤痕/, 'scar'],
    [/绷带/, 'bandages'],
    [/耳环|耳饰/, 'earrings'],
    [/项链|挂坠/, 'necklace'],
];
// 服装（柏宝书的 npc.outfit / protagonist.outfit 常写这些）
const OUTFIT = [
    [/风衣|大衣/, 'trench coat'],
    [/和服|浴衣/, 'kimono'],
    [/制服/, 'uniform'],
    [/西装|正装/, 'suit'],
    [/盔甲|铠甲/, 'armor'],
    [/斗篷|披风/, 'cape'],
    [/连衣裙|长裙/, 'dress'],
    [/旗袍/, 'qipao'],
    [/道袍|道服|宗门服饰/, 'chinese robes'],
    [/卫衣|连帽/, 'hoodie'],
    [/毛衣/, 'sweater'],
    [/衬衫/, 'shirt'],
    [/短裙/, 'skirt'],
    [/牛仔裤/, 'jeans'],
];
// 体型
const BUILD = [
    [/高挑|修长|身材高/, 'tall'],
    [/娇小|矮小|小巧/, 'short stature'],
    [/瘦削|纤瘦|清瘦|瘦/, 'slim'],
    [/丰满|丰腴/, 'curvy'],
    [/健壮|魁梧|壮硕/, 'muscular'],
];

function pick(list, text, out) {
    for (const [re, tag] of list) {
        if (re.test(text) && !out.includes(tag)) out.push(tag);
    }
}

/**
 * 从角色卡描述抽取英文外观标签串。
 * 抽不到足够信息（连性别都没有）时返回 null，让上层决定兜底。
 */
export function looksFromCard(card) {
    const parts = [];
    const desc = [card && card.description, card && card.personality, card && card.scenario,
        card && card.first_mes, card && card.mes_example]
        .filter(Boolean).join('\n').slice(0, 4000);
    if (!desc) return null;

    // 性别：优先看开头常见的「17 male」「男」「1boy」，避免从「父亲是男人」里误判
    const head = desc.slice(0, 300);
    let gender = null;
    if (/\b(?:male|boy)\b|\b1boy\b|(?:^|\s)男(?:性|孩|生|人)?(?:\s|,|，|$)/i.test(head)) gender = '1boy';
    else if (/\b(?:female|girl|woman)\b|\b1girl\b|(?:^|\s)女(?:性|孩|生|人)?(?:\s|,|，|$)/i.test(head)) gender = '1girl';
    if (!gender) {
        // 全卡范围内再找一次：年龄紧邻性别，或「少女 / 少年」这类词
        if (/\d{1,2}\s*(?:岁|年)?\s*(?:male|男)|少年|男孩/.test(desc)) gender = '1boy';
        else if (/\d{1,2}\s*(?:岁|年)?\s*(?:female|女)|少女|女孩/.test(desc)) gender = '1girl';
    }
    if (gender) parts.push(gender);

    pick(HAIR_ZH, desc, parts);
    pick(HAIR_EN, desc, parts);
    pick(EYE, desc, parts);
    pick(HAIR_STYLE, desc, parts);
    pick(TRAIT, desc, parts);
    // 「半长发」会同时命中 medium / long，去掉泛化的 long
    if (parts.includes('medium length hair')) {
        const i = parts.indexOf('long hair');
        if (i >= 0) parts.splice(i, 1);
    }

    // 年龄感
    if (/高中生|未成年|少年|学生|1[0-7]\s*(?:岁|male|female)/.test(desc.slice(0, 400))) parts.push('young');
    else if (/成年|2\d\s*(?:岁|male|female)|职场|社会人/.test(desc.slice(0, 400)) && !parts.includes('adult')) parts.push('adult');

    // 至少要性别 + 一个外观特征，才算可用
    if (parts.length < 2) return null;
    return [...new Set(parts)].join(', ');
}

/**
 * 从「记忆插件的人物档案」抽英文外观标签。
 * 柏宝书 npc 结构：{ name, gender, age, desc(固定外貌), outfit(当前着装), title }
 * 主角结构：{ gender, age, appearance, outfit, identity }
 * 和 looksFromCard 共用同一套中文→标签词表，但字段是分开的，这里拼成一段再抽。
 */
export function looksFromMemory(person) {
    if (!person || typeof person !== 'object') return null;
    const pieces = [person.desc, person.appearance, person.outfit, person.title]
        .filter(Boolean).join('，');
    if (!pieces) return null;

    // 性别：记忆里 gender 是明确的「男/女/female/male」，优先用它
    let gender = null;
    const g = String(person.gender || '').trim();
    if (/^(男|male|boy|男性|男生)/i.test(g)) gender = '1boy';
    else if (/^(女|female|girl|女性|女生)/i.test(g)) gender = '1girl';

    const out = [];
    if (gender) out.push(gender);

    const text = pieces.slice(0, 1200);
    // 复用角色卡那套抽取（性别靠上面显式字段，这里只取外观特征）
    pick(HAIR_ZH, text, out);
    pick(HAIR_EN, text, out);
    pick(EYE, text, out);
    pick(HAIR_STYLE, text, out);
    pick(TRAIT, text, out);
    pick(OUTFIT, text, out);
    pick(BUILD, text, out);
    if (out.includes('medium length hair')) {
        const i = out.indexOf('long hair');
        if (i >= 0) out.splice(i, 1);
    }
    // 年龄感
    const age = String(person.age || '');
    const atext = age + ' ' + text.slice(0, 200);
    if (/少年|少女|学生|1[0-7]\s*(?:岁|年)/.test(atext)) out.push('young');
    else if (/成年|2\d\s*岁|职场|社会人/.test(atext)) out.push('adult');

    if (out.length < 2) return null;
    return [...new Set(out)].join(', ');
}

/**
 * 从记忆里的地点描述抽英文背景标签（复用 art.js 的中文场景词表思路，
 * 但这里是独立模块，避免循环依赖：直接返回中文原文 + 通用背景标签，
 * 由 art.js 的 scenePrompt 再加工）。
 */
export function sceneFromMemory(scene) {
    if (!scene) return null;
    const name = String(scene.name || '').trim();
    const desc = String(scene.desc || '').trim();
    const path = Array.isArray(scene.path) ? scene.path.join('·') : '';
    if (!name && !desc) return null;
    return { name, desc, path: path || name };
}
