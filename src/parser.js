// ============================================
// parser.js — 双解析引擎，输出统一"剧本对象"
//   协议模式：识别 [scene:][char:|表情][bgm:][choice:][qte:] 等标签
//   智能模式：纯文本 → 引号切对白、说话人识别、场景关键词猜测
// 两个引擎输出同构，下游渲染不关心来源。
// ============================================

import { guessScene } from './assets.js';

// ---------- 公共工具 ----------

// 噪声标签的「词根」。允许带后缀（<think_nya> / <reasoning_v2> 这类），
// 因为不少预设会给思考标签加后缀，写死闭合标签就会整段漏进正文。
// 注意：不要把 summary 放进来。它是 <details> 的标题（「内心-某角色」），
// 属于结构标签不是噪声块；当成噪声剥掉的话，心声就分不清是谁的了。
const NOISE_ROOTS = 'think|thinking|reasoning|thought|thoughts|analyze|analysis|reflection|brainstorm|scratchpad|inner_?monologue|comment|comments|note|notes|meta|plan|planning|outline|draft';

// 剥离思维链 / 推理 / 作者备注 / OOC 等杂项（在 markdown 清理之前）
function stripNoise(s) {
    // 成对噪声块：开闭标签都吃后缀。
    // 实测踩过的坑：旧正则开标签用 [^>]* 能匹配 <think_nya>，但闭合标签
    // 写死成 </\1>，于是 <think_nya>…</think_nya> 整块没被剥掉，
    // 只剩 <...> 被 cleanText 抹掉，AI 的推理全文（上千字、几十屏）
    // 就被当成旁白一段段播出去了。
    const pair = new RegExp(
        `<(${NOISE_ROOTS})[A-Za-z0-9_\\-]*[^>]*>[\\s\\S]*?<\\/\\1[A-Za-z0-9_\\-]*\\s*>`, 'gi');
    // 可能嵌套（<comment> 里套 <think>），反复剥到不再变化
    for (let i = 0, prev = null; i < 8 && s !== prev; i++) { prev = s; s = s.replace(pair, ''); }

    // 未闭合的噪声块：从开标签起整段丢弃，避免吞掉正文
    const openRe = new RegExp(`<(${NOISE_ROOTS})[A-Za-z0-9_\\-]*[^>]*>`, 'i');
    const closeRe = new RegExp(`<\\/(${NOISE_ROOTS})[A-Za-z0-9_\\-]*\\s*>`, 'i');
    let guard = 0;
    while (guard++ < 8) {
        const om = openRe.exec(s);
        if (!om) break;
        const after = s.slice(om.index + om[0].length);
        if (closeRe.test(after)) break;          // 还有闭合标签 → 交给下一轮成对剥离
        s = s.slice(0, om.index);                // 真的没关 → 后面全是推理，丢掉
    }

    // 首行 Reasoning: / Thinking: 段落
    s = s.replace(/^\s*(?:Reasoning|Thinking|Thought|reasoning|thinking)[:：][^\n]*$/gm, '');
    // OOC 备注 ((...))
    s = s.replace(/\(\([\s\S]*?\)\)/g, '');
    return s;
}

// ---------- 第三方模板块提取 ----------
// 很多角色卡自带一套输出模板（<game> / <options> / <details> / <bbs_*>）。
// 这些块必须在 cleanText 之前处理：cleanText 会把所有 <...> 抹平，
// 抹完就分不清哪段是选项、哪段是内心独白，全部变成旁白念一遍
// （实测三个选项被当成正文念了出来，结尾又冒出一个通用选项）。
// 做法：把块换成占位符，正文照旧走行解析，最后按占位符原位插回，顺序不乱。
const BLOCK_MARK = '\u0001B';
const BLOCK_RE = /\u0001B(\d+)\u0001/g;

function extractBlocks(raw) {
    const blocks = [];
    const keep = (seg) => { blocks.push(seg); return `${BLOCK_MARK}${blocks.length - 1}\u0001`; };
    const plain = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
        // 块内文本同样要修边：跨块的引号会在块尾留下孤零零的 ”，
        // 之前它单独成了一屏旁白。
        .replace(/^[，,。、；;：:\s“”「」『』"'‘’]+/, '')
        .replace(/[：:，,、；;\s“”「」『』"'‘’]+$/, '')
        .trim();
    let s = String(raw || '');

    // <options><option>…</option></options> → 可点选项
    s = s.replace(/<options[^>]*>([\s\S]*?)<\/options>/gi, (m, inner) => {
        let opts = [...inner.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/gi)].map(x => plain(x[1])).filter(Boolean);
        if (!opts.length) {
            opts = inner.split(/\n+/).map(x => plain(x.replace(/^[\s\-*•·\d.、)）]+/, ''))).filter(Boolean);
        }
        opts = opts.map(x => x.replace(/^[\s\-*•·]+/, '').trim()).filter(Boolean).slice(0, 4);
        return opts.length ? keep({ t: 'choice', opts }) : '';
    });
    // 落单的 <option>
    s = s.replace(/<option[^>]*>([\s\S]*?)<\/option>/gi, (m, inner) => {
        const t = plain(inner);
        return t ? keep({ t: 'narr', text: t }) : '';
    });

    // <details><summary>内心-某某</summary>…</details> → 心声段（和旁白区分开）
    s = s.replace(/<details[^>]*>([\s\S]*?)<\/details>/gi, (m, inner) => {
        const sm = inner.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
        const label = sm ? plain(sm[1]) : '';
        const body = plain(inner.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, ''));
        if (!body) return '';
        const who = label.replace(/^[\s【\[]*(?:内心|心声|心理|想法|独白)[-—－:：\s]*/, '').replace(/[\s】\]]+$/, '').trim();
        return keep({ t: 'inner', who: who || null, text: body });
    });

    // <background>…</background> → 幕间旁白（别的角色同时在做什么）
    // 里面常按「【地点】：做了什么」分行，把地点抽成场景切换，
    // 正文才不会顶着【】标签头被念出来。
    s = s.replace(/<background[^>]*>([\s\S]*?)<\/background>/gi, (m, inner) => {
        const t = plain(inner);
        if (!t) return '';
        const out = [];
        for (const line of t.split(/\n+/).map(x => x.trim()).filter(Boolean)) {
            const meta = line.match(/^【([^】]{2,24})】\s*[：:]\s*(.*)$/);
            if (meta) {
                const place = meta[1].trim();
                if (/[·・]/.test(place) || /(宗|阁|殿|院|谷|堂|山|城|坊|室|洞|楼|门|派|府|街|林|海)/.test(place)) {
                    out.push(keep({ t: 'dir', scene: place }));
                }
                if (meta[2].trim()) out.push(keep({ t: 'narr', text: meta[2].trim(), interlude: true }));
            } else {
                out.push(keep({ t: 'narr', text: line, interlude: true }));
            }
        }
        return out.join('');
    });

    // <bbs_*> 状态栏模板：时间地点保留成一行提示，其余（变量/物品栏）丢掉
    s = s.replace(/<bbs_items[^>]*>[\s\S]*?<\/bbs_items>/gi, '');
    s = s.replace(/<bbs_vars[^>]*>[\s\S]*?<\/bbs_vars>/gi, '');
    // bbs_start 里是「日期·时辰」这类模板时间戳，不是剧情正文。
    // 留着会在第一屏播报「玄历……午时一刻」，看起来像有人在念系统提示。
    s = s.replace(/<bbs_start[^>]*>[\s\S]*?<\/bbs_start>/gi, '');
    s = s.replace(/<bbs_end[^>]*>[\s\S]*?<\/bbs_end>/gi, '');

    // 纯容器：只脱壳，正文保留
    s = s.replace(/<\/?(?:game|bbs|body|story|content|main|scene_box)[^>]*>/gi, '');
    // 第三方占位符
    s = s.replace(/<StatusPlaceHolder[A-Za-z0-9_]*[^>]*\/?>/gi, '');
    return { text: s, blocks };
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
// 「面向 / 朝 / 顺着」也算介词头：「某角色面向楼梯口…」→ 该角色名
const PREP_HEAD = /^[在向从把将对给用和与跟替为到于面朝顺沿]/;
// 人名末尾不会粘这些身体/神态字。命中说明截取过头了
// （「某角色面」其实是「角色名」+「面向」的第一个字）。
const STATE_TAIL = /[面色容态神情眼手声头脚步影身背腰唇眉指脸颊眸]$/;

function tryPrefixName(head) {
    for (let len = 2; len <= 4 && len < head.length; len++) {
        const p = head.slice(0, len);
        if (STATE_TAIL.test(p)) continue;
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

// 名字后面紧跟这些字，说明它是动作/说话的主语，而不是被提到的宾语。
// 「谢知微挑眉扫了姜伯珩一眼」里，说话的是谢知微，不是姜伯珩。
const SPEECH_HINT = /(?:说|道|问|答|喊|叫|笑道|冷笑|挑眉|瞥|扫|冲|朝|对|向|摆手|抬手|伸手|拉住|拽住|抓住|摸出|递过|接过|点头|摇头|皱眉|哼|嘟囔|低声|声音|语气|的声|的语|却|便|就|一|把|将|在|看着|望着|听|面向|转过|走|站|坐)/;

function scoreNameAt(text, n, idx) {
    const tail = text.slice(idx + n.length, idx + n.length + 10);
    return idx + (SPEECH_HINT.test(tail) ? 0 : 18);
}

// 从「引号前的文本」里推断说话人
// 1) 已知名字优先：取「名字后面像主语」的那个；不再无脑取最靠右
// 2) 否则取第一个短句，看它像不像人名
function pickSpeaker(pre, knownNames) {
    let text = String(pre || '')
        .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')   // 去括号动作
        .replace(/[*~`_]/g, '')
        .trim();
    if (!text) return null;

    // 1) 已知名字优先。原先取最靠右的名字，遇到
    // 「谢知微挑眉扫了姜伯珩一眼…「姜师弟…」」会把台词挂在姜伯珩名下。
    // 现在给紧跟动作词的名字更低分，优先取真正的主语。
    let best = null;
    for (const n of namePool(knownNames)) {
        if (n.length < 2) continue;
        let from = 0, idx;
        while ((idx = text.indexOf(n, from)) >= 0) {
            const score = scoreNameAt(text, n, idx);
            if (!best || score < best.score || (score === best.score && n.length > best.n.length)) {
                best = { n, score };
            }
            from = idx + n.length;
        }
    }
    if (best) return best.n;

    // 2) 去掉「说/道/问」等尾巴后取首句，再剥掉动词短语看剩下的是不是人名
    const head = text
        .split(/[，,。；;：:！!？?]/)[0]
        .replace(/^\s*(于是|然后|接着|这时|这时候|紧接着)\s*/, '')
        .trim();
    const bare = stripVerbTail(head);
    // 「某某面向楼梯口略微颔首」→ 旧逻辑推出「某某面」，名字栏显示成一个
    // 根本不存在的人，还会凭空多生成一张立绘。末尾粘了身体/神态字时截掉。
    if (bare.length >= 3 && STATE_TAIL.test(bare)) {
        const cut = bare.slice(0, -1);
        if (isNameLike(cut)) return cut;
    }
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
        if ((seg.t === 'narr' || seg.t === 'say' || seg.t === 'inner') && seg.text && seg.text.length > max) {
            for (const piece of splitText(seg.text, max)) {
                out.push(seg.t === 'narr'
                    ? Object.assign({}, seg, { text: piece })
                    : Object.assign({}, seg, { text: piece }));
            }
        } else {
            out.push(seg);
        }
    }
    script.segments = out;
    return script;
}

// 碎句合并：引号切分会在正文里留下「和」「残印。」这种 1~4 字的残渣，
// 每一条都要单独占一屏、单独点一次「继续」，手机上极其难受。
// 规则：连续旁白里，短于 min 的片段并进上一条；没有上一条就并入下一条。
function mergeTiny(script, min = 6) {
    const segs = script.segments;
    const out = [];
    let carry = null;   // 等待并入下一条的残渣
    for (const seg of segs) {
        const tiny = (seg.t === 'narr') && seg.text && seg.text.length < min;
        if (tiny) {
            const prev = out[out.length - 1];
            if (prev && prev.t === 'narr' && !prev.stamp) {
                prev.text = prev.text + seg.text;      // 直接接上，不加分隔符
                continue;
            }
            carry = carry ? carry + seg.text : seg.text;
            continue;
        }
        if (carry) {
            if (seg.t === 'narr') {
                seg.text = carry + seg.text;
            } else if (seg.t === 'say') {
                out.push({ t: 'narr', text: carry });
            } else {
                out.push({ t: 'narr', text: carry });
            }
            carry = null;
        }
        out.push(seg);
    }
    if (carry) out.push({ t: 'narr', text: carry });
    script.segments = out;
    return script;
}

// ---------- 协议标签解析 ----------
// 兼容全角/半角括号、大小写、中英文冒号
// 演出标签：scene/char/bgm/choice/qte/cg
// 游戏系统标签：stats/item/quest/aff/dice/input（RPG Maker 风格）
const TAG_LINE_RE = /^[\s>]*[\[【]\s*(scene|char|look|bgm|choice|qte|cg|stats|item|quest|aff|dice|input)\s*[：:=]\s*([^\]】]*)[\]】]\s*/i;

// 任务状态词 → 统一枚举
const QUEST_ST = { '开始': 'start', '新': 'start', 'new': 'start', '接受': 'start', '进行': 'start', '完成': 'done', 'done': 'done', '达成': 'done', '失败': 'fail', 'fail': 'fail', '放弃': 'fail' };

// 【地点】：幕间说明 —— 「镜头切到别处，某人在做什么」的过场，不是角色台词。
// 切成「切场景 + 幕间旁白」，顺带驱动背景，也避免和正文对白混在一起。
// 两种模式（协议 / 智能）共用。返回是否命中。
function pushSceneMeta(script, line) {
    const meta = String(line || '').trim().match(/^【([^】]{2,24})】\s*[：:]\s*(.+)$/);
    if (!meta) return false;
    const place = meta[1].trim();
    const body = meta[2].trim();
    if (/[·・]/.test(place) || /(宗|阁|殿|院|谷|堂|山|城|坊|室|洞|楼|门|派|府|街|林|海)/.test(place)) {
        script.segments.push({ t: 'dir', scene: place });
    }
    if (body) script.segments.push({ t: 'narr', text: body, interlude: true });
    return true;
}

function parseProtocol(text, knownNames) {
    const script = { mode: 'protocol', scene: null, bgm: null, segments: [] };
    // 先剥噪声、再抽第三方块，最后才逐行解析正文。
    // 顺序不能反：cleanText 会把所有 <...> 抹平，抹完就分不清选项和旁白。
    const { text: body, blocks } = extractBlocks(stripNoise(text));
    let lastChar = null; // [char:] 标签的最近角色，用于无名对白归属
    let lastNarrSpeaker = null; // 最近一段「某人做某事」叙述里的主语

    const emit = (seg) => {
        // 模板常把同一个时间戳写两遍（<bbs_start> 出现两次），去掉重复的那条
        const prev = script.segments[script.segments.length - 1];
        if (prev && seg.stamp && prev.stamp && prev.text === seg.text) return;
        script.segments.push(seg);
    };

    const feedLine = (raw, nextLines = []) => {
        let line = raw.trim();
        if (!line) return;
        // 剥离行首连续标签（如 [char:xx][bgm:yy] 正文）
        let guard = 0;
        while (guard++ < 6) {
            const m = line.match(TAG_LINE_RE);
            if (!m) break;
            const tag = m[1].toLowerCase();
            const val = m[2].trim();
            line = line.slice(m[0].length);
            if (tag === 'scene') script.segments.push({ t: 'dir', scene: val });
            else if (tag === 'look') {
                // [look:角色名|英文外观标签] —— 给生图用的固定外观，不进演出
                const [ln, lt] = val.split(/[|｜]/).map(x => x.trim());
                if (ln && lt) {
                    if (!script.looks) script.looks = {};
                    script.looks[ln] = lt;
                    learnNames([ln]);
                }
            }
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
        if (!line.trim()) return;
        if (pushSceneMeta(script, line)) return;
        const hasQuote = /[「『“"]/.test(line);
        if (!hasQuote) {
            const ns = narrSpeaker(line, knownNames);
            if (ns) lastNarrSpeaker = ns;
        }
        let fallback = lastNarrSpeaker || lastChar;
        // 对白独占一行、说话人写在后面叙述里时，向后看几行：
        // 「聚宝阁……」→「姜伯珩神色平平淡淡的……」
        // 「哥。」→「里屋……姜伯瑾慢吞吞地走了出来。」
        // 遇到下一段独占一行的对白就停：那是另一个人的台词，别把它的主语偷过来。
        if (/^[「『“"]/.test(line) && !pickSpeakerAfter(line, knownNames)) {
            for (const nx of nextLines) {
                if (/^[「『“][^」』”]{1,120}[」』”]\s*$/.test(nx.trim())) break;
                const w = narrSpeaker(nx, knownNames);
                if (w) { fallback = w; break; }
            }
        }
        pushSpeech(script, line.trim(), knownNames, fallback);
    };

    // 按占位符切段：正文 / 块 / 正文 / 块…，原位插回，阅读顺序不乱
    const parts = body.split(BLOCK_RE);
    const items = [];
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
            const b = blocks[Number(parts[i])];
            if (b) items.push({ block: b });
            continue;
        }
        for (const raw of cleanText(parts[i]).split(/\n+/)) {
            if (raw.trim()) items.push({ line: raw.trim() });
        }
    }
    for (let i = 0; i < items.length; i++) {
        if (items[i].block) { emit(items[i].block); continue; }
        feedLine(items[i].line, items.slice(i + 1, i + 5)
            .filter(x => x.line).map(x => x.line));
    }
    // 起始 scene/bgm 取第一个 dir 的值（舞台初始状态）
    script.scene = (script.segments.find(s => s.t === 'dir' && s.scene) || {}).scene || null;
    script.bgm = (script.segments.find(s => s.t === 'dir' && s.bgm) || {}).bgm || null;
    return script;
}

function hasProtocolTag(text) {
    return /[\[【]\s*(scene|char|look|bgm|choice|qte|cg|stats|item|quest|aff|dice|input)\s*[：:=]/i.test(text)
        // 第三方模板（<game> / <options> / <bbs_*>）也算协议味：这类卡片
        // 往往把 [scene:] 藏在 <game> 里，光看方括号标签容易漏判。
        || /<(?:game|options|option|bbs_[a-z]+|details)\b[^>]*>/i.test(text);
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
    // 引号被跨行切断时会留下孤零零的 “ 或 ” 单独成屏（实测「”」占了一整屏）。
    // 首尾的引号和标点一起剥掉。
    return String(s || '')
        .replace(/^[，,。、；;：:\s“”「」『』"'‘’]+/, '')
        .replace(/[：:，,、；;\s“”「」『』"'‘’]+$/, '')
        .trim();
}

// 从引号后面的动作描写反推说话人：
// 「行了，李师弟…」谢知微挑眉扫了姜伯珩一眼…
// 「不用谢我…」谢知微冲他摆了摆手…
// 「师兄，是我。」→ 下一行「言逸清润温和的声音隔着门板传进来」
function pickSpeakerAfter(after, knownNames) {
    const raw = String(after || '').trim();
    if (!raw) return null;
    const cut = raw.search(/[「『“"]/);
    const seg = (cut >= 0 ? raw.slice(0, cut) : raw).slice(0, 48);
    let best = null;
    for (const n of namePool(knownNames)) {
        if (n.length < 2) continue;
        let from = 0, idx;
        while ((idx = seg.indexOf(n, from)) >= 0) {
            const tail = seg.slice(idx + n.length, idx + n.length + 10);
            if (SPEECH_HINT.test(tail) || /^[，,、；;]/.test(tail) || /^的/.test(tail)) {
                const score = idx - (SPEECH_HINT.test(tail) ? 6 : 0);
                if (!best || score < best.score) best = { n, score };
                break;
            }
            from = idx + n.length;
        }
    }
    return best ? best.n : null;
}

// 一句话里没有引号时，看看它像不像「某人做了某事」的叙述，
// 记下来给前后无主的对白兜底用。
function narrSpeaker(line, knownNames) {
    // 只取第一组引号之前的叙述部分：
    // 「言逸清润温和的声音……，「下午我去……」」里，主语在引号前。
    const t = String(line || '').trim().split(/[「『“]/)[0].trim();
    if (!t) return null;
    let best = null;
    for (const n of namePool(knownNames)) {
        if (n.length < 2) continue;
        const idx = t.indexOf(n);
        if (idx < 0 || idx > 24) continue;
        const score = idx + (SPEECH_HINT.test(t.slice(idx + n.length, idx + n.length + 10)) ? 0 : 18);
        if (!best || score < best.score) best = { n, score };
    }
    return best ? best.n : null;
}

// 一行文本 → 若干 say/narr 段（支持一行里多组引号）
function pushSpeech(script, line, knownNames, fallbackSpeaker) {
    const re = new RegExp(QUOTE_RE.source, 'g');
    let m, cursor = 0, any = false;
    while ((m = re.exec(line))) {
        const quote = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        const before = line.slice(cursor, m.index).trim();
        const after = line.slice(re.lastIndex);
        // 短引号往往是绰号/术语而不是台词，例如「把『某个绰号』这顶帽子按实」。
        // 旧逻辑会切成 say(绰号) + narr(这顶帽子按实。)，屏幕上就像有人
        // 凭空喊了一句绰号。这种引号整体并回一条旁白。
        if (quote && quote.length <= 8 && !/[。！？!?…；;，,、]/.test(quote)
            && before.length >= 8 && after && /^[\u4e00-\u9fa5]/.test(after)) {
            script.segments.push({ t: 'narr', text: cleanNarr(before + '「' + quote + '」' + after) });
            return;
        }
        any = true;
        // 先看引号后面的动作描写：它比「引号前出现了谁」更可靠。
        // 例：「不用谢我……」谢知微冲他摆了摆手 —— 说话人是谢知微。
        const afterWho = pickSpeakerAfter(after, knownNames);
        let who = afterWho || null;
        if (!who && before) {
            who = pickSpeaker(before, knownNames);
            if (who) learnNames([who]);
            else {
                const narr = cleanNarr(before);
                if (narr) script.segments.push({ t: 'narr', text: narr });
            }
        } else if (!who && fallbackSpeaker) {
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
    // 智能模式也会遇到第三方模板（<options> / <details> / <background>），
    // 先抽块再清文本，否则选项和内心独白会被当成正文念一遍。
    const { text: rawBody, blocks } = extractBlocks(stripNoise(text));
    const cleaned = cleanText(rawBody).replace(BLOCK_RE, '\n');
    const blockChoice = blocks.find(b => b.t === 'choice') || null;
    const blockRest = blocks.filter(b => b.t !== 'choice');
    if (!cleaned.trim() && !blockRest.length) return script;
    script.scene = guessScene(cleaned);
    script.bgm = guessMood(cleaned);
    let lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const tail = splitTrailingOptions(lines);
    lines = tail.rest;

    let lastSpeaker = null;
    let lastNarrSpeaker = null;
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (pushSceneMeta(script, line)) continue;
        // "名字：对白" 无引号格式（仅已知角色名）
        const colon = line.match(/^([^\s:：，。！？]{1,10})\s*[：:]\s*(.+)$/);
        if (colon && namePool(knownNames).includes(colon[1])) {
            lastSpeaker = colon[1];
            script.segments.push({ t: 'say', who: colon[1], text: colon[2].trim() });
            continue;
        }
        const hasQuote = /[「『“"]/.test(line);
        if (!hasQuote) {
            const ns = narrSpeaker(line, knownNames);
            if (ns) lastNarrSpeaker = ns;
        }
        // 一些段落把整句对白单独成行，说话人写在下一行的叙述里：
        // 「伯瑾？」→「里屋…姜伯瑾慢吞吞地走了出来。」
        let lookahead = null;
        if (hasQuote && !pickSpeakerAfter(line, knownNames) && !pickSpeaker(
            line.slice(0, Math.max(0, line.search(/[「『“"]/))), knownNames)) {
            for (let j = li + 1; j < Math.min(lines.length, li + 3) && !lookahead; j++) {
                lookahead = narrSpeaker(lines[j], knownNames);
            }
        }
        const before = script.segments.length;
        pushSpeech(script, line, knownNames, lookahead || lastNarrSpeaker || lastSpeaker);
        for (let i = before; i < script.segments.length; i++) {
            const s = script.segments[i];
            if (s.t === 'say' && s.who) lastSpeaker = s.who;
        }
    }
    // 幕间 / 心声等块补在正文之后
    for (const b of blockRest) script.segments.push(b);
    // 结尾的选项列表 → 可点选项；模板里的 <options> 优先
    if (tail.options.length >= 2) {
        script.segments.push({ t: 'choice', opts: tail.options.slice(0, 4) });
    } else if (blockChoice) {
        script.segments.push(blockChoice);
    }
    return script;
}

// 智能模式：抓取 AI 写出来的「行动选项」，转成可点按钮。
// 目标：只要 AI 明确列了 2 条以上备选行动，就直接抓过来，不要再退化成
// 「回应/观察四周/静观其变」这种通用项（用户明确要求「有生成选项就直接抓」）。
//
// 支持格式（行首编号，2 条以上连续出现即可）：
//   1. / 1、/ 1) / 1： / (1) / （1） / ① / 一、/ 一）
//   A. / A、/ A： / a) / （A）
//   - / * / • / · / ▸ 等无序符号
//   加粗 **1. 选项**、`1. 选项`、[选项] 前缀也会被剥掉。
// 另外支持两种「标题式」：**选项一：内容** / 选项1：内容 —— 正文里内联出现也能抓。
const OPT_NUM = '(?:[1-9０-９]|[A-Da-d]|[一二三四五六七八九十]|[①②③④⑤⑥⑦⑧⑨⑩])';
const OPT_LINE_RE = new RegExp(
    '^\\s*(?:'
    // 编号 + 标点：1. / 1、/ 1：/ 一、/ （1）、
    + '(?:[（(]?\\s*' + OPT_NUM + '\\s*[）)]?\\s*[.、．：:,，]\\s*)'
    // 圈号直接跟内容：① 走左边
    + '|(?:[①②③④⑤⑥⑦⑧⑨⑩]\\s+)'
    // 括号编号 + 空格（无标点）：(1) 走左边
    + '|(?:[（(]\\s*' + OPT_NUM + '\\s*[）)]\\s+)'
    // 无序符号
    + '|(?:[-*•·▪▸►]\\s+)'
    + ')(.{1,60})$'
);
const OPT_LABEL_RE = /^(选项|你的选择|请选择|如何行动|你要怎么做|你要做什么|选择|下一步|接下来|可选行动|行动选项|你的行动)[：:]?$/;
// 「选项一：去做某事」这类：标题和内容在同一行
const OPT_INLINE_RE = /^(?:选项|选择|行动|方案|行动选项)\s*[：:]?\s*([一二三四五六七八九十1-9０-９A-Da-d①②③④⑤⑥⑦⑧⑨⑩])[.、．：:,，]?\s*(.{1,60})$/;

function cleanOptText(s) {
    return String(s || '')
        .replace(/^[*`_~\[\]【】\s]+/, '')
        .replace(/[*`_~\s]+$/, '')
        .replace(/[.。；;]+$/, '')
        .trim();
}

// 去掉 markdown 加粗/代码符号后再判定编号，避免 **1. xxx** 漏抓
function optTextOf(line) {
    const s = String(line || '').replace(/[*`_~]/g, '').trim();
    const m = OPT_LINE_RE.exec(s);
    if (m && m[1] && m[1].trim()) return cleanOptText(m[1]);
    const im = OPT_INLINE_RE.exec(s);
    if (im && im[2] && im[2].trim()) return cleanOptText(im[2]);
    return null;
}

function splitTrailingOptions(lines) {
    // 从结尾往前找连续选项行（跳过纯标题行，但不跳过正文）
    const picked = [];   // { i, text }
    for (let i = lines.length - 1; i >= 0; i--) {
        if (OPT_LABEL_RE.test(lines[i].trim())) continue; // 标题行不算正文，继续往上
        const t = optTextOf(lines[i]);
        if (!t) break;
        picked.unshift({ i, text: t });
    }
    let run = picked;
    // 选项不在最末尾（后面还有旁白/时间戳等）时，全文扫一遍找最长的一段连续选项
    if (run.length < 2) {
        let best = [];
        let cur = [];
        for (let i = 0; i < lines.length; i++) {
            const t = OPT_LABEL_RE.test(lines[i].trim()) ? null : optTextOf(lines[i]);
            if (t) cur.push({ i, text: t });
            else { if (cur.length > best.length) best = cur; cur = []; }
        }
        if (cur.length > best.length) best = cur;
        if (best.length >= 2) run = best;
    }
    if (run.length < 2) return { options: [], rest: lines };
    // 只把真正抓到选项的行从正文移除；标题行也一起移除（它在选项正上方或夹在中间）
    const idx = new Set(run.map(p => p.i));
    let cut = run[0].i;
    // 往上吃掉紧邻的标题行
    while (cut - 1 >= 0 && OPT_LABEL_RE.test(lines[cut - 1].trim())) { cut--; idx.add(cut); }
    const rest = lines.filter((_, i) => !idx.has(i));
    return { options: run.map(p => p.text).slice(0, 4), rest };
}

// ---------- 兜底行动项 ----------
// AI 没写 [choice:] / 选项列表时，这一幕就没有任何可点的东西 → 玩家卡住。
// 这里补三个通用行动项，保证永远有得点。
const INTERACTIVE = new Set(['choice', 'input', 'qte', 'dice']);

function hasInteractive(script) {
    return (script.segments || []).some(s => INTERACTIVE.has(s.t));
}

function synthOptions(script, ctxInfo = {}) {
    let who = null;
    for (let i = script.segments.length - 1; i >= 0; i--) {
        const s = script.segments[i];
        if (s.t === 'say' && s.who) { who = s.who; break; }
    }
    // 没有说话人 → 用这一幕最后出场的角色（chars 末尾是最新的）
    if (!who && Array.isArray(script.chars) && script.chars.length) {
        who = script.chars[script.chars.length - 1].name;
    }
    // 说话人是玩家自己 → 别再「回应自己」
    if (who && ctxInfo.userName && who === ctxInfo.userName) who = null;
    const opts = [who ? '回应' + who : '开口说话', '观察四周', '静观其变'];
    return opts;
}

// ---------- 统一入口 ----------
// ctxInfo: { charName, userName, members: [], chunk, autoChoice } 用于说话人吸附与断句长度
function parseMessage(raw, ctxInfo = {}) {
    if (!raw || typeof raw !== 'string') return null;
    const knownNames = [ctxInfo.charName, ctxInfo.userName, ...(ctxInfo.members || [])]
        .filter(Boolean).filter(n => n !== '你' && String(n).length <= 12);
    let script;
    // 判定用「剥掉噪声后」的文本：思考块里常贴协议示例，
    // 拿原文判定会把纯文本回复误判成协议模式。
    const probe = stripNoise(raw);
    if (hasProtocolTag(probe)) {
        script = parseProtocol(probe, knownNames);
    } else {
        script = parseSmart(probe, knownNames);
    }
    // 先合并碎句，再切长句：反过来会把切出来的碎片又留成一屏
    mergeTiny(script, 6);
    // 长句按标点切屏
    expandLongSegments(script, Number(ctxInfo.chunk) || 60);
    // 兜底：清掉任何 narr 段里残留的「【地点】：」标签头（<background> 多行块
    // 只会被抽到第一行，其余行还顶着标签）。顺手把地点补成场景切换。
    {
        const fixed = [];
        for (const seg of script.segments) {
            if (seg.t === 'narr' && seg.text) {
                const m = seg.text.match(/^【([^】]{2,24})】\s*[：:]\s*(.*)$/);
                if (m) {
                    const place = m[1].trim();
                    if (/[·・]/.test(place) || /(宗|阁|殿|院|谷|堂|山|城|坊|室|洞|楼|门|派|府|街|林|海)/.test(place)) {
                        const prev = fixed[fixed.length - 1];
                        if (!(prev && prev.t === 'dir' && prev.scene === place)) {
                            fixed.push({ t: 'dir', scene: place });
                        }
                    }
                    if (m[2].trim()) fixed.push(Object.assign({}, seg, { text: m[2].trim() }));
                    continue;
                }
            }
            fixed.push(seg);
        }
        script.segments = fixed;
    }
    // 台词说话人不做「从上下文猜」：试过，会把哥哥的台词挂到弟弟名下，
    // 比不显示名字更误导。正确做法是让 AI 写 [char:]（见 protocol.js 第 22 条）。

    // 收集出场角色（最多 3 个最近说话人）
    const seen = new Set();
    script.chars = [];
    for (let i = script.segments.length - 1; i >= 0; i--) {
        const s = script.segments[i];
        const name = (s.t === 'say' || s.t === 'inner') ? (s.who || null)
            : (s.t === 'dir' && s.char ? s.char.name : null);
        if (name && !seen.has(name)) {
            seen.add(name);
            script.chars.unshift({ name, expr: (s.char && s.char.expr) || null });
        }
        if (script.chars.length >= 3) break;
    }
    learnNames(script.chars.map(c => c.name));

    // 兜底：这一幕没有任何可交互段落 → 自动补三个行动项
    if (ctxInfo.autoChoice && !hasInteractive(script) && script.segments.length) {
        script.segments.push({ t: 'choice', opts: synthOptions(script, ctxInfo), synthetic: true });
        script.synthetic = true;
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
export { parseMessage, EXPR_NAMES, learnNames, resetLearned, pickSpeaker, splitText, hasInteractive };
