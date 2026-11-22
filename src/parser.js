// ============================================
// parser.js — 双解析引擎，输出统一"剧本对象"
//   协议模式：识别 [scene:][char:|表情][bgm:][choice:][qte:] 标签
//   智能模式：纯文本 → 引号切对白、说话人启发式识别、场景关键词猜测
// 两个引擎输出同构，下游渲染不关心来源。
// ============================================

import { guessScene } from './assets.js';

// ---------- 公共工具 ----------

// 清理 markdown 噪声，保留可读文本
function cleanText(s) {
    return s
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
const TAG_LINE_RE = /^[\s>]*[\[【]\s*(scene|char|bgm|choice|qte)\s*[：:=]\s*([^\]】]*)[\]】]\s*/i;

function parseProtocol(text, knownNames) {
    const script = { mode: 'protocol', scene: null, bgm: null, segments: [] };
    const lines = cleanText(text).split(/\n+/);
    let lastChar = null; // [char:] 标签的最近角色，用于无名对白归属
    for (let raw of lines) {
        let line = raw.trim();
        if (!line) continue;
        // 剥离行首连续标签（如 [char:xx][bgm:yy] 正文）
        let guard = 0;
        while (guard++ < 4) {
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
    return /[\[【]\s*(scene|char|bgm|choice|qte)\s*[：:=]/i.test(text);
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

function parseSmart(text, knownNames) {
    const script = { mode: 'smart', scene: null, bgm: null, segments: [] };
    const cleaned = cleanText(text);
    if (!cleaned.trim()) return script;
    script.scene = guessScene(cleaned);
    script.bgm = guessMood(cleaned);
    const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
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
