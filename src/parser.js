// ============================================
// parser.js — 双解析引擎，输出统一"剧本对象"
//   协议模式：识别 [scene:][char:|表情][bgm:][choice:][qte:] 等标签
//   智能模式：纯文本 → 引号切对白、说话人识别、场景关键词猜测
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

// ---------- 说话人识别 ----------
// 目标：宁可认不出（不显示名字），也不要把「雨声」「这时」当成人名。

// 明显不是人名的词（代词 / 时间 / 方位 / 常见物象 / 常见动词短语）
const NOT_NAME = new Set([
    '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '它们', '大家', '众人', '有人', '对方',
    '那人', '这人', '此人', '某人', '自己', '别人', '旁人', '两人', '三人', '所有人', '其他人',
    '这时', '此时', '那时', '片刻', '沉默', '空气', '气氛', '四周', '周围', '四周一片', '房间', '屋里',
    '门外', '窗外', '远处', '近处', '头顶', '脚下', '身前', '身后', '身边', '手中', '手里', '桌上',
    '声音', '脚步', '脚步声明', '雨声', '风声', '雷声', '灯光', '月光', '阳光', '夜色', '天色', '光线',
    '心中', '心里', '眼中', '眼前', '目光', '眼神', '嘴角', '眉头', '呼吸', '心跳', '身体', '肩膀',
    '然后', '接着', '于是', '随即', '顿时', '立刻', '马上', '忽然', '突然', '猛然', '缓缓', '轻轻',
    '微微', '静静', '默默', '终于', '似乎', '仿佛', '好像', '依然', '仍然', '依旧', '不禁', '忍不住',
    '看着', '望着', '听着', '想着', '说着', '笑着', '走着', '站着', '坐着', '转身', '点头', '摇头',
    '当然', '不过', '但是', '可是', '因此', '所以', '总之', '然而', '只是', '如果', '虽然',
]);

// 出现这些字基本不是单纯人名（动词/助词/介词残留）
const BAD_CHARS = '的了着过是在有就都也还又很太更最被把向从对给将让使和与或但却而则因为所以吗呢吧啊呀哦嗯';

// 首句里常见的「动词短语尾巴」，先剥掉再看剩下的是不是人名
// 例：「她抬起头」→「她」；「管理员推开门」→「管理员」
const VERB_TAIL = /(?:推|打|抬|转|站|坐|笑|叹|点|摇|伸|收|握|看|望|听|走|跑|说|问|答|喊|叫|低|皱|咬|吸|吐|闭|睁|回|离|靠|蹲|跪|趴|捏|拍|敲|摸|擦|揉|抓|拉|扯|拎|抱|扶|搂|踢|踩|跳|躺|醒|睡|哭|愣|怔|呆|沉默|皱眉|抬头|低头|回头|转身|起身|坐下|站起)(?:着|了|过|起|开|下|上|住|到|来|去)?[^\s]{0,3}$/;

function stripVerbTail(s) {
    let prev = null;
    let t = s;
    while (prev !== t) {
        prev = t;
        t = t.replace(VERB_TAIL, '').trim();
    }
    return t;
}

// 「老人在炉边坐下」这类：主语 + 介词短语，取前缀当人名
const PREP_HEAD = /^[在向从把将对给用和与跟替为到于]/;

function tryPrefixName(head) {
    for (let len = 2; len <= 4 && len < head.length; len++) {
        const p = head.slice(0, len);
        if (/^[我你他她它\d]/.test(p)) continue;
        if (!isNameLike(p)) continue;
        const rest = head.slice(len);
        if (PREP_HEAD.test(rest) || VERB_TAIL.test(rest)) return p;
    }
    return null;
}

// 已知角色名（每次解析由 ctxInfo 提供），以及本次会话学到的名字
let _learned = new Set();

function learnNames(names) {
    for (const n of names || []) {
        const s = String(n || '').trim();
        if (s && s.length >= 2 && s.length <= 12) _learned.add(s);
    }
}
function resetLearned() { _learned = new Set(); }

function namePool(knownNames) {
    const pool = new Set();
    for (const n of knownNames || []) if (n) pool.add(String(n).trim());
    for (const n of _learned) pool.add(n);
    return [...pool].filter(Boolean);
}

// 判断一个短词像不像人名
function isNameLike(s) {
    if (!s) return false;
    const t = s.trim();
    if (t.length < 2 || t.length > 6) return false;
    if (!/^[\u4e00-\u9fa5A-Za-z·・]+$/.test(t)) return false;   // 只允许中日文 / 拉丁 / 间隔号
    if (NOT_NAME.has(t)) return false;
    // 「众人议论纷纷」「夜色浓得像墨」→ 前缀是常见词，整串不可能是人名
    for (let i = 2; i < t.length; i++) {
        if (NOT_NAME.has(t.slice(0, i))) return false;
    }
    for (const ch of t) if (BAD_CHARS.includes(ch)) return false;
    return true;
}

// 从「引号前的文本」里推断说话人
// 1) 文本里出现已知名字 → 取最靠右（最接近引号）的那个
// 2) 否则取第一个短句，看它像不像人名
function pickSpeaker(pre, knownNames) {
    let text = String(pre || '')
        .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')   // 去括号动作
        .replace(/[*~`_]/g, '')
        .trim();
    if (!text) return null;

    // 1) 已知名字优先（包含匹配，取最靠右、最长的）
    let best = null;
    for (const n of namePool(knownNames)) {
        if (n.length < 2) continue;
        const idx = text.lastIndexOf(n);
        if (idx < 0) continue;
        if (!best || idx > best.idx || (idx === best.idx && n.length > best.n.length)) best = { n, idx };
    }
    if (best) return best.n;

    // 2) 去掉「说/道/问」等尾巴后取首句，再剥掉动词短语看剩下的是不是人名
    const head = text
        .split(/[，,。；;：:！!？?]/)[0]
        .replace(/^\s*(于是|然后|接着|这时|这时候|紧接着)\s*/, '')
        .trim();
    const bare = stripVerbTail(head);
    if (isNameLike(bare)) return bare;
    // 英文名：「Alice smiled」→ Alice
    const latin = head.match(/^[A-Z][A-Za-z'’\-]{1,15}/);
    if (latin) return latin[0];
    return tryPrefixName(head);
}

// ---------- 断句 ----------
// 长文本按标点切成多屏，避免一屏塞进整段旁白（手机上尤其难受）
const SENT_END = /[。！？!?…；;]/;
const SOFT_BREAK = /[，,、]/;

function splitText(text, max) {
    const s = String(text || '');
    if (!s || s.length <= max) return [s];
    const out = [];
    let buf = '';
    for (const ch of s) {
        buf += ch;
        if (SENT_END.test(ch) && buf.length >= 6) { out.push(buf); buf = ''; }
        else if (buf.length >= max && SOFT_BREAK.test(ch)) { out.push(buf); buf = ''; }
    }
    if (buf) out.push(buf);
    return out.map(x => x.trim()).filter(Boolean);
}

function expandLongSegments(script, max) {
    if (!max || max < 12) return script;
    const out = [];
    for (const seg of script.segments) {
        if ((seg.t === 'narr' || seg.t === 'say') && seg.text && seg.text.length > max) {
            for (const piece of splitText(seg.text, max)) {
                out.push(seg.t === 'say' ? { t: 'say', who: seg.who, text: piece } : { t: 'narr', text: piece });
            }
        } else {
            out.push(seg);
        }
    }
    script.segments = out;
    return script;
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
                    learnNames([name]);
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
                    learnNames([parts[0]]);
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

function cleanNarr(s) {
    return String(s || '')
        .replace(/^[，,。、；;：:\s]+/, '')
        .replace(/[：:，,、；;\s]+$/, '')   // 去掉引号前残留的冒号
        .trim();
}

// 一行文本 → 若干 say/narr 段（支持一行里多组引号）
function pushSpeech(script, line, knownNames, fallbackSpeaker) {
    const re = new RegExp(QUOTE_RE.source, 'g');
    let m, cursor = 0, any = false;
    while ((m = re.exec(line))) {
        any = true;
        const quote = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        const before = line.slice(cursor, m.index).trim();
        let who = null;
        if (before) {
            who = pickSpeaker(before, knownNames);
            if (who) learnNames([who]);
            else {
                const narr = cleanNarr(before);
                if (narr) script.segments.push({ t: 'narr', text: narr });
            }
        } else if (fallbackSpeaker) {
            who = fallbackSpeaker;
        }
        if (quote) script.segments.push({ t: 'say', who, text: quote });
        cursor = re.lastIndex;
    }
    if (!any) {
        const narr = cleanNarr(line);
        if (narr) script.segments.push({ t: 'narr', text: narr });
        return;
    }
    // 引号后面的动作描写不要丢
    const tail = cleanNarr(line.slice(cursor));
    if (tail) script.segments.push({ t: 'narr', text: tail });
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
        if (colon && namePool(knownNames).includes(colon[1])) {
            lastSpeaker = colon[1];
            script.segments.push({ t: 'say', who: colon[1], text: colon[2].trim() });
            continue;
        }
        const before = script.segments.length;
        pushSpeech(script, line, knownNames, lastSpeaker);
        for (let i = before; i < script.segments.length; i++) {
            const s = script.segments[i];
            if (s.t === 'say' && s.who) lastSpeaker = s.who;
        }
    }
    // 结尾的选项列表 → 可点选项
    if (tail.options.length >= 2) {
        script.segments.push({ t: 'choice', opts: tail.options.slice(0, 4) });
    }
    return script;
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

// ---------- 统一入口 ----------
// ctxInfo: { charName, userName, members: [], chunk } 用于说话人吸附与断句长度
function parseMessage(raw, ctxInfo = {}) {
    if (!raw || typeof raw !== 'string') return null;
    const knownNames = [ctxInfo.charName, ctxInfo.userName, ...(ctxInfo.members || [])]
        .filter(Boolean).filter(n => n !== '你' && String(n).length <= 12);
    let script;
    if (hasProtocolTag(raw)) {
        script = parseProtocol(raw, knownNames);
    } else {
        script = parseSmart(raw, knownNames);
    }
    // 长句按标点切屏
    expandLongSegments(script, Number(ctxInfo.chunk) || 60);

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
    learnNames(script.chars.map(c => c.name));

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
export { parseMessage, EXPR_NAMES, learnNames, resetLearned, pickSpeaker, splitText };
