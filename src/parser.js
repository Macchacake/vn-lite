// ============================================
// parser.js — 双解析引擎，输出统一"剧本对象"
//   协议模式：识别 [scene:][char:|表情][bgm:][choice:][qte:] 标签
//   智能模式：纯文本 → 引号切对白、说话人启发式识别、场景关键词猜测
// 两个引擎输出同构，下游渲染不关心来源。
// ============================================

import { guessScene } from './assets.js';

// ---------- 公共工具 ----------

// 剥离思维链 / 推理 / OOC 等杂项（在 markdown 清理之前）
function stripNoise(s) {
    // 成对的思考标签：<thinking>...</thinking> 等（常见于 DeepSeek-R1 / 各类推理模型）
    s = s.replace(/<(think|thinking|reasoning|thought|thoughts|analyze|analysis|reflection|brainstorm|scratchpad|inner_?monologue|summary)[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    // 未闭合的思考标签：从开标签起整段丢弃（模型忘关标签时防止吞掉正文判断）
    if (/<(think|thinking|reasoning)>/i.test(s) && !/<\/(think|thinking|reasoning)>/i.test(s)) {
        s = s.replace(/<(?:think|thinking|reasoning)>[\s\S]*$/i, '');
    }
    // 首行 Reasoning: / Thinking: 段落
    s = s.replace(/^\s*(?:Reasoning|Thinking|Thought|reasoning|thinking)[:：][^\n]*$/gm, '');
    // OOC 备注 ((...))
    s = s.replace(/\(\([\s\S]*?\)\)/g, '');
    return s;
}

// 清理 markdown 噪声，保留可读文本
function cleanText(s) {
    return stripNoise(s)
        .replace(/```[\s\S]*?```/g, '')      // 代码块
        .replace(/<[^>]+>/g, '')             // HTML 标签
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
        .replace(/[*~`#>_]+/g, ' ')
        .replace(/\u00a0/g, ' ');
}

const QUOTE_RE = /[「『]([^」』]*?)[」』]|[“]([^“”]*?)[”]|"([^"\n]{2,})"/;

// 说话人提取：去掉括号动作、语气副词、言说动词
const ADVERBS = '轻声|低声|大声|小声|急切地|慢慢地|突然|悄悄|缓缓|微微|冷冷|温柔地|温和地|无奈地|兴奋地|开心地|慌张地|惊讶地|生气地|冷静地|淡淡';
const VERBS = '说道|说|道|问|问道|喊|喊道|叫|叫道|答|回答|笑道|苦笑|哭道|低语|开口|怒道|骂道|嘀咕|抱怨|吼|嘶吼|回复|补充|喃喃';

function extractSpeaker(pre, knownNames) {
    let s = pre
        .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')   // 去动作括号
        .replace(/[*~`_]/g, '')
        .replace(/^\s*(于是|然后|接着|这时|这时候|紧接着)?\s*/, '')
        .trim();
    // 反复剥离末尾的 "副词+动词" 尾巴
    let prev = null;
    while (prev !== s) {
        prev = s;
        s = s.replace(new RegExp(`(${ADVERBS})?(${VERBS})(着|了|道|:|：)?[，,。！!？?\\s]*$`), '').trim();
    }
    s = s.replace(/[，,。:：!！?？\s]+$/, '').replace(/^[，,。:：\s]+/, '');
    if (!s || s.length > 10 || /[。！？!?"」』]/.test(s)) return null;
    // 已知角色名模糊吸附（包含匹配）
    if (knownNames && knownNames.length) {
        for (const n of knownNames) {
            if (n && (s === n || s.includes(n) || n.includes(s))) return n;
        }
    }
    return s;
}

// ---------- 协议标签解析 ----------
// 兼容全角/半角括号、大小写、中英文冒号
// 演出标签：scene/char/bgm/choice/qte/cg
// 游戏系统标签：stats/item/quest/aff/dice/input（RPG Maker 风格）
const TAG_LINE_RE = /^[\s>]*[\[【]\s*(scene|char|bgm|choice|qte|cg|stats|item|quest|aff|dice|input)\s*[：:=]\s*([^\]】]*)[\]】]\s*/i;

// 任务状态词 → 统一枚举
const QUEST_ST = { '开始': 'start', '新': 'start', 'new': 'start', '接受': 'start', '进行': 'start', '完成': 'done', 'done': 'done', '达成': 'done', '失败': 'fail', 'fail': 'fail', '放弃': 'fail' };

function parseProtocol(text, knownNames) {
    const script = { mode: 'protocol', scene: null, bgm: null, segments: [] };
    const lines = cleanText(text).split(/\n+/);
    let lastChar = null; // [char:] 标签的最近角色，用于无名对白归属
    for (let raw of lines) {
        let line = raw.trim();
        if (!line) continue;
        // 剥离行首连续标签（如 [char:xx][bgm:yy] 正文）
        let guard = 0;
        while (guard++ < 6) {
            const m = line.match(TAG_LINE_RE);
            if (!m) break;
            const tag = m[1].toLowerCase();
            const val = m[2].trim();
            line = line.slice(m[0].length);
            if (tag === 'scene') script.segments.push({ t: 'dir', scene: val });
            else if (tag === 'bgm') script.segments.push({ t: 'dir', bgm: val });
            else if (tag === 'char') {
                const [name, expr] = val.split(/[|｜]/).map(x => x.trim());
                if (name) {
                    script.segments.push({ t: 'dir', char: { name, expr: expr || null } });
                    lastChar = name;
                }
            } else if (tag === 'choice') {
                const opts = val.split(/[|｜/]/).map(x => x.trim()).filter(Boolean).slice(0, 4);
                if (opts.length) script.segments.push({ t: 'choice', opts });
            } else if (tag === 'qte') {
                if (val) script.segments.push({ t: 'qte', text: val });
            } else if (tag === 'cg') {
                // [cg:english prompt] — 演出插画（ComfyUI 生成）
                if (val) script.segments.push({ t: 'cg', prompt: val });
            } else if (tag === 'stats') {
                // [stats:HP|80/100|MP|30/50|金币|120] —— 标签与值用 | 交替
                const parts = val.split(/[|｜]/).map(x => x.trim()).filter(Boolean);
                const items = [];
                for (let i = 0; i + 1 < parts.length; i += 2) items.push({ label: parts[i], val: parts[i + 1] });
                if (items.length) script.segments.push({ t: 'stats', items });
            } else if (tag === 'item') {
                // [item:+治疗药水x2] / [item:-铁剑]
                const m2 = val.match(/^([+＋\-－])\s*(.+?)(?:\s*[x×](\d+))?$/);
                if (m2) script.segments.push({ t: 'item', op: /[+＋]/.test(m2[1]) ? '+' : '-', name: m2[2].trim(), qty: m2[3] ? Number(m2[3]) : 1 });
            } else if (tag === 'quest') {
                // [quest:开始|任务名|描述] / [quest:完成|任务名]
                const parts = val.split(/[|｜]/).map(x => x.trim());
                const st = QUEST_ST[parts[0].toLowerCase()] || QUEST_ST[parts[0]] || 'start';
                if (parts[1]) script.segments.push({ t: 'quest', st, name: parts[1], desc: parts[2] || null });
            } else if (tag === 'aff') {
                // [aff:角色名|+2] / [aff:角色名|-1]
                const parts = val.split(/[|｜]/).map(x => x.trim());
                if (parts[0]) {
                    const d = parseInt(parts[1] || '1', 10);
                    script.segments.push({ t: 'aff', name: parts[0], delta: isNaN(d) ? 1 : d });
                }
            } else if (tag === 'dice') {
                // [dice:1d20|15|成功剧情|失败剧情] —— 掷 N 面骰，≥目标算成功
                const parts = val.split(/[|｜]/).map(x => x.trim());
                const m2 = (parts[0] || '').match(/^(\d*)d(\d+)$/i);
                if (m2) script.segments.push({
                    t: 'dice',
                    n: Math.min(5, Math.max(1, Number(m2[1]) || 1)),
                    faces: Number(m2[2]) || 6,
                    target: Number(parts[1]) || 1,
                    okText: parts[2] || null,
                    failText: parts[3] || null,
                });
            } else if (tag === 'input') {
                // [input:提示语] —— 玩家自由输入
                if (val) script.segments.push({ t: 'input', hint: val });
            }
        }
        if (!line.trim()) continue;
        pushSpeech(script, line.trim(), knownNames, lastChar);
    }
    // 起始 scene/bgm 取第一个 dir 的值（舞台初始状态）
    script.scene = (script.segments.find(s => s.t === 'dir' && s.scene) || {}).scene || null;
    script.bgm = (script.segments.find(s => s.t === 'dir' && s.bgm) || {}).bgm || null;
    return script;
}

function hasProtocolTag(text) {
    return /[\[【]\s*(scene|char|bgm|choice|qte|cg|stats|item|quest|aff|dice|input)\s*[：:=]/i.test(text);
}

// ---------- 智能解析（零配置） ----------
const MOOD_KW = {
    '欢快': ['笑', '开心', '高兴', '愉快', '哈哈', '兴奋', '雀跃'],
    '悲伤': ['哭', '泪', '悲伤', '难过', '伤心', '叹息'],
    '紧张': ['危险', '紧张', '快跑', '来不及', '心跳', '颤抖'],
    '神秘': ['神秘', '奇怪', '诡异', '低语', '呢喃'],
    '温馨': ['温暖', '温馨', '柔和', '拥抱', '安心'],
};

function guessMood(text) {
    let best = '平静', hits = 0;
    for (const [m, kws] of Object.entries(MOOD_KW)) {
        let h = 0;
        for (const kw of kws) if (text.includes(kw)) h++;
        if (h > hits) { best = m; hits = h; }
    }
    return best;
}

function pushSpeech(script, line, knownNames, fallbackSpeaker) {
    const m = line.match(QUOTE_RE);
    if (m) {
        const quote = m[1] ?? m[2] ?? m[3];
        const pre = line.slice(0, m.index);
        const speaker = extractSpeaker(pre, knownNames);
        if (pre.trim() && !speaker) {
            // 引号前的长文本是旁白
            script.segments.push({ t: 'narr', text: pre.trim() });
        }
        // 说话人优先级：显式前缀 > fallback（协议模式的 [char:]）
        const who = speaker || (fallbackSpeaker && !pre.trim() ? fallbackSpeaker : speaker);
        script.segments.push({ t: 'say', who, text: quote.trim() });
        // 引号后的剩余文本不再处理（通常是动作描述，合并进旁白太碎）
    } else {
        script.segments.push({ t: 'narr', text: line.trim() });
    }
}

// 智能模式兜底：识别结尾的「选项列表」，转成可点选项
// 支持 1. / 1、/ 1) / A. / - / * / • 等常见列表格式，且必须连续出现 2 条以上
const OPT_LINE_RE = /^\s*(?:([1-9１-９]|[A-Da-d])\s*[.、)．:：]\s*|[-*•·]\s*)(.{1,40})$/;
const OPT_LABEL_RE = /^(选项|你的选择|请选择|如何行动|你要怎么做|选择|下一步)[：:]?$/;

function splitTrailingOptions(lines) {
    const options = [];
    let cut = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = OPT_LINE_RE.exec(lines[i]);
        if (!m) break;
        options.unshift(m[2].trim());
        cut = i;
    }
    if (options.length < 2) return { options: [], rest: lines };
    const rest = lines.slice(0, cut);
    while (rest.length && OPT_LABEL_RE.test(rest[rest.length - 1].trim())) rest.pop();
    return { options, rest };
}

function parseSmart(text, knownNames) {
    const script = { mode: 'smart', scene: null, bgm: null, segments: [] };
    const cleaned = cleanText(text);
    if (!cleaned.trim()) return script;
    script.scene = guessScene(cleaned);
    script.bgm = guessMood(cleaned);
    let lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const tail = splitTrailingOptions(lines);
    lines = tail.rest;
    let lastSpeaker = null;
    for (const line of lines) {
        // "名字：对白" 无引号格式（仅已知角色名）
        const colon = line.match(/^([^\s:：，。！？]{1,10})\s*[：:]\s*(.+)$/);
        if (colon && knownNames && knownNames.includes(colon[1])) {
            lastSpeaker = colon[1];
            script.segments.push({ t: 'say', who: colon[1], text: colon[2].trim() });
            continue;
        }
        if (QUOTE_RE.test(line)) {
            // 按引号顺序游走：每段引号前的短文本决定说话人
            const re = new RegExp(QUOTE_RE.source, 'g');
            let m, cursor = 0;
            while ((m = re.exec(line))) {
                const before = line.slice(cursor, m.index).trim();
                const quote = (m[1] ?? m[2] ?? m[3] ?? '').trim();
                if (before) {
                    let spk = extractSpeaker(before, knownNames);
                    if (!spk && before.length <= 10 && !/[。，！？]/.test(before)) spk = before;
                    if (spk) { lastSpeaker = spk; }
                    else {
                        // 前置长文本不是说话人 → 旁白
                        script.segments.push({ t: 'narr', text: before.replace(/^[，,。]\s*/, '') });
                    }
                }
                if (quote) script.segments.push({ t: 'say', who: lastSpeaker, text: quote });
                cursor = re.lastIndex;
            }
            const tail = line.slice(cursor).trim();
            if (tail) script.segments.push({ t: 'narr', text: tail.replace(/^[，,。]\s*/, '') });
        } else {
            script.segments.push({ t: 'narr', text: line });
        }
    }
    // 结尾的选项列表 → 可点选项
    if (tail.options.length >= 2) {
        script.segments.push({ t: 'choice', opts: tail.options.slice(0, 4) });
    }
    return script;
}

// ---------- 统一入口 ----------
// ctxInfo: { charName, userName, members: [] } 用于说话人吸附
function parseMessage(raw, ctxInfo = {}) {
    if (!raw || typeof raw !== 'string') return null;
    const knownNames = [ctxInfo.charName, ctxInfo.userName, ...(ctxInfo.members || [])]
        .filter(Boolean).filter(n => n !== '你' && n.length <= 12);
    let script;
    if (hasProtocolTag(raw)) {
        script = parseProtocol(raw, knownNames);
    } else {
        script = parseSmart(raw, knownNames);
    }
    // 收集出场角色（最多 3 个最近说话人）
    const seen = new Set();
    script.chars = [];
    for (let i = script.segments.length - 1; i >= 0; i--) {
        const s = script.segments[i];
        const name = s.t === 'say' ? s.who : (s.t === 'dir' && s.char ? s.char.name : null);
        if (name && !seen.has(name)) {
            seen.add(name);
            script.chars.unshift({ name, expr: (s.char && s.char.expr) || null });
        }
        if (script.chars.length >= 3) break;
    }
    // 降级保护：一段都没有 → 全文一条旁白
    if (!script.segments.length) {
        const fallback = cleanText(raw).trim();
        if (!fallback) return null;
        script.segments.push({ t: 'narr', text: fallback.slice(0, 500) });
        script.degraded = true;
    }
    script.usable = script.segments.some(s => s.t !== 'dir');
    return script;
}

const EXPR_NAMES = ['平静', '微笑', '难过', '生气', '惊讶', '害羞', '严肃', '得意'];
export { parseMessage, EXPR_NAMES };
