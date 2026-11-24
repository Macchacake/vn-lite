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
    const desc = [card && card.description, card && card.personality]
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
