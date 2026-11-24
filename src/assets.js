// ============================================
// assets.js — 场景背景 / 剪影立绘 SVG 生成（零外部资源）
// 所有素材均为程序生成 SVG data URI，按需缓存。
// ============================================

// ---------- 工具 ----------
function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h;
}

function svgURI(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/\n\s*/g, ''));
}

// ---------- 场景类目（协议模式的通用大类 + 智能模式关键词猜测） ----------
// 每项: kw 关键词, art SVG 片段（viewBox 450x800）
const G = (id, from, to, extra = '') =>
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
    `<rect width="450" height="800" fill="url(#${id})"/>${extra}`;

const SCENE_DEFS = {
    '室内': {
        kw: ['房间', '屋里', '室内', '家中'],
        art: G('g', '#4a4038', '#2a2521',
            '<rect x="60" y="140" width="150" height="180" rx="6" fill="#ffffff" opacity="0.12"/><rect x="330" y="200" width="80" height="420" rx="6" fill="#000000" opacity="0.18"/>'),
    },
    '教室': {
        kw: ['教室', '课桌', '黑板', '讲台', '上课', '放学', '同学', '老师', '课堂'],
        art: G('g', '#5a6478', '#323849',
            '<rect x="40" y="120" width="370" height="210" rx="8" fill="#cdd8ee" opacity="0.22"/><g stroke="#e8eefc" stroke-opacity="0.3" stroke-width="4"><line x1="130" y1="120" x2="130" y2="330"/><line x1="225" y1="120" x2="225" y2="330"/><line x1="320" y1="120" x2="320" y2="330"/><line x1="40" y1="225" x2="410" y2="225"/></g><rect x="0" y="620" width="450" height="180" fill="#3a2f26" opacity="0.55"/>'),
    },
    '走廊': {
        kw: ['走廊', '楼道', '楼梯间'],
        art: G('g', '#6b6a72', '#3c3b44',
            '<g fill="#000000" opacity="0.2"><rect x="30" y="220" width="90" height="330" rx="4"/><rect x="330" y="220" width="90" height="330" rx="4"/></g><rect x="0" y="640" width="450" height="160" fill="#55524a" opacity="0.6"/>'),
    },
    '操场': {
        kw: ['操场', '跑道', '运动场', '体育课', '球场'],
        art: G('g', '#7fb2d9', '#c8dce8',
            '<circle cx="360" cy="130" r="52" fill="#fff6d8" opacity="0.85"/><rect x="0" y="520" width="450" height="280" fill="#7fa86a" opacity="0.8"/><g stroke="#ffffff" stroke-opacity="0.45" stroke-width="6"><line x1="0" y1="640" x2="450" y2="640"/><line x1="0" y1="720" x2="450" y2="720"/></g>'),
    },
    '校园': {
        kw: ['校园', '学校', '校门', '林荫'],
        art: G('g', '#8fc3e8', '#dff0d8',
            '<circle cx="90" cy="140" r="44" fill="#fff3cf" opacity="0.9"/><g fill="#4d7a3e" opacity="0.75"><ellipse cx="80" cy="520" rx="95" ry="80"/><ellipse cx="380" cy="560" rx="110" ry="90"/><ellipse cx="225" cy="600" rx="130" ry="70"/></g>'),
    },
    '街道': {
        kw: ['街道', '马路', '街头', '路口', '城市', ' downtown', '人行道'],
        art: G('g', '#4a4660', '#241f2e',
            '<g fill="#0e0c16"><rect x="20" y="250" width="90" height="300"/><rect x="130" y="180" width="120" height="380"/><rect x="270" y="260" width="70" height="300"/><rect x="360" y="220" width="80" height="340"/></g><g fill="#ffd98a" opacity="0.8"><rect x="150" y="220" width="14" height="18"/><rect x="185" y="260" width="14" height="18"/><rect x="150" y="330" width="14" height="18"/><rect x="380" y="260" width="14" height="18"/></g><rect x="0" y="620" width="450" height="180" fill="#191621"/>'),
    },
    '商店': {
        kw: ['商店', '便利店', '超市', '店里', '购物'],
        art: G('g', '#7a5c4a', '#3e2e26',
            '<rect x="40" y="200" width="370" height="180" fill="#e8d8c0" opacity="0.25"/><g fill="#d95f5f" opacity="0.55"><rect x="40" y="180" width="370" height="40"/><g fill="#fff" opacity="0.5"><rect x="60" y="180" width="30" height="40"/><rect x="100" y="180" width="30" height="40"/><rect x="140" y="180" width="30" height="40"/><rect x="180" y="180" width="30" height="40"/><rect x="220" y="180" width="30" height="40"/><rect x="260" y="180" width="30" height="40"/><rect x="300" y="180" width="30" height="40"/><rect x="340" y="180" width="30" height="40"/></g></g>'),
    },
    '餐厅': {
        kw: ['餐厅', '食堂', '饭馆', '吃饭', '餐桌'],
        art: G('g', '#6b4633', '#3a2419',
            '<g stroke="#ffcf8a" stroke-width="5" opacity="0.7"><line x1="120" y1="0" x2="120" y2="120"/><line x1="330" y1="0" x2="330" y2="120"/></g><circle cx="120" cy="150" r="26" fill="#ffd98a" opacity="0.85"/><circle cx="330" cy="150" r="26" fill="#ffd98a" opacity="0.85"/><rect x="0" y="600" width="450" height="200" fill="#2b1a12" opacity="0.7"/>'),
    },
    '咖啡馆': {
        kw: ['咖啡', '咖啡馆', '奶茶', '下午茶'],
        art: G('g', '#5d4636', '#2f221a',
            '<rect x="60" y="160" width="330" height="240" rx="10" fill="#f5e8d5" opacity="0.14"/><path d="M150,420 q10,-40 30,-40 q20,0 30,40 z" fill="#3a2a1e" opacity="0.6"/><path d="M240,420 q10,-46 30,-46 q20,0 30,46 z" fill="#3a2a1e" opacity="0.6"/>'),
    },
    '卧室': {
        kw: ['卧室', '床', '睡觉', '被窝', '枕头'],
        art: G('g', '#43465e', '#232433',
            '<rect x="270" y="120" width="130" height="160" rx="6" fill="#0d0f1c" opacity="0.8"/><circle cx="335" cy="190" r="26" fill="#f4eebe" opacity="0.9"/><rect x="20" y="560" width="300" height="130" rx="14" fill="#2b2d44"/><rect x="40" y="520" width="120" height="50" rx="8" fill="#5a5e80" opacity="0.7"/>'),
    },
    '客厅': {
        kw: ['客厅', '沙发', '电视', '茶几'],
        art: G('g', '#6a5a4c', '#372e26',
            '<rect x="90" y="170" width="270" height="160" rx="6" fill="#0d121c" opacity="0.75"/><rect x="60" y="540" width="260" height="120" rx="16" fill="#4a3b2f"/><rect x="90" y="510" width="200" height="40" rx="10" fill="#5d4a3a"/>'),
    },
    '浴室': {
        kw: ['浴室', '洗澡', '浴缸', '淋浴', '热气'],
        art: G('g', '#9fc4cf', '#5b7a86',
            '<g stroke="#ffffff" stroke-opacity="0.25" stroke-width="3"><line x1="0" y1="200" x2="450" y2="200"/><line x1="0" y1="260" x2="450" y2="260"/><line x1="0" y1="320" x2="450" y2="320"/><line x1="0" y1="380" x2="450" y2="380"/></g><path d="M200,420 q-14,-50 6,-90 M240,420 q-14,-50 6,-90" stroke="#ffffff" stroke-width="8" fill="none" opacity="0.2" stroke-linecap="round"/>'),
    },
    '厨房': {
        kw: ['厨房', '做饭', '锅', '菜'],
        art: G('g', '#8a7a68', '#4a4038',
            '<rect x="0" y="520" width="450" height="280" fill="#5a5044" opacity="0.8"/><rect x="40" y="480" width="370" height="30" rx="4" fill="#8d8272"/><circle cx="150" cy="465" r="16" fill="#2b2622"/><rect x="300" y="440" width="60" height="30" rx="4" fill="#2b2622"/>'),
    },
    '办公室': {
        kw: ['办公室', '公司', '上班', '工位', '会议室'],
        art: G('g', '#5c6470', '#2e333c',
            '<rect x="50" y="140" width="350" height="200" rx="6" fill="#b8c6dd" opacity="0.16"/><g stroke="#dbe6f5" stroke-opacity="0.22" stroke-width="3"><line x1="170" y1="140" x2="170" y2="340"/><line x1="280" y1="140" x2="280" y2="340"/><line x1="50" y1="240" x2="400" y2="240"/></g><rect x="0" y="620" width="450" height="180" fill="#26292f" opacity="0.85"/>'),
    },
    '森林': {
        kw: ['森林', '树林', '林间', '树荫', '丛林'],
        art: G('g', '#2c4a33', '#152619',
            '<g fill="#0d1a10" opacity="0.85"><rect x="60" y="0" width="34" height="620" rx="12"/><rect x="200" y="0" width="44" height="640" rx="14"/><rect x="350" y="0" width="30" height="600" rx="10"/></g><g fill="#3d6b47" opacity="0.7"><ellipse cx="120" cy="120" rx="90" ry="60"/><ellipse cx="330" cy="100" rx="100" ry="65"/><ellipse cx="220" cy="60" rx="120" ry="55"/></g>'),
    },
    '山路': {
        kw: ['山', '山路', '山顶', '爬山', '丘陵'],
        art: G('g', '#7fa8c9', '#c9d8b8',
            '<path d="M-20,560 L120,260 L260,560 Z" fill="#4a5b52" opacity="0.9"/><path d="M180,560 L340,300 L480,560 Z" fill="#5d6e60" opacity="0.9"/><circle cx="370" cy="120" r="40" fill="#fff6d8" opacity="0.9"/>'),
    },
    '海边': {
        kw: ['海边', '海', '沙滩', '大海', '海风', '海浪'],
        art: G('g', '#7ec2e3', '#e8d9b0',
            '<circle cx="340" cy="140" r="46" fill="#fff3c2" opacity="0.95"/><rect x="0" y="460" width="450" height="340" fill="#3f8fb5" opacity="0.8"/><g stroke="#eaf6ff" stroke-width="5" opacity="0.5" fill="none"><path d="M0,500 q60,-18 120,0 q60,18 120,0 q60,-18 120,0"/><path d="M0,570 q60,-18 120,0 q60,18 120,0 q60,-18 120,0"/><path d="M0,650 q60,-18 120,0 q60,18 120,0 q60,-18 120,0"/></g>'),
    },
    '河边': {
        kw: ['河边', '小溪', '河', '湖', '池塘', '溪'],
        art: G('g', '#6faf8f', '#39543f',
            '<rect x="0" y="480" width="450" height="320" fill="#4d7a99" opacity="0.85"/><path d="M0,560 q80,-24 160,0 q80,24 160,0 q80,-24 130,10" stroke="#dff0f8" stroke-width="6" fill="none" opacity="0.5"/><ellipse cx="80" cy="120" rx="70" ry="28" fill="#fff" opacity="0.5"/><ellipse cx="150" cy="90" rx="50" ry="20" fill="#fff" opacity="0.4"/>'),
    },
    '雪地': {
        kw: ['雪', '雪地', '下雪', '雪原', '积雪'],
        art: G('g', '#c9d6e8', '#f2f6fb',
            '<rect x="0" y="560" width="450" height="240" fill="#ffffff"/><g fill="#5b7290" opacity="0.5"><path d="M60,560 L130,380 L200,560 Z"/><path d="M250,560 L330,360 L410,560 Z"/></g>'),
    },
    '夜空': {
        kw: ['夜晚', '夜空', '星空', '月亮', '深夜', '夜里'],
        art: G('g', '#141c33', '#0a0e1d',
            '<circle cx="330" cy="160" r="56" fill="#f2edc8" opacity="0.95"/><circle cx="352" cy="140" r="50" fill="#141c33"/><g fill="#ffffff"><circle cx="80" cy="120" r="2.4"/><circle cx="160" cy="220" r="1.8"/><circle cx="60" cy="300" r="2"/><circle cx="400" cy="330" r="2.2"/><circle cx="220" cy="90" r="1.6"/><circle cx="120" cy="420" r="1.8"/><circle cx="380" cy="480" r="1.6"/></g>'),
    },
    '雨天': {
        kw: ['雨', '下雨', '雨天', '暴雨', '淋湿'],
        art: G('g', '#5d6a78', '#333b45',
            '<g stroke="#aebfd4" stroke-width="2" opacity="0.4"><line x1="60" y1="0" x2="30" y2="180"/><line x1="180" y1="40" x2="150" y2="220"/><line x1="300" y1="0" x2="270" y2="180"/><line x1="400" y1="60" x2="370" y2="240"/><line x1="110" y1="260" x2="80" y2="440"/><line x1="330" y1="300" x2="300" y2="480"/></g><rect x="0" y="620" width="450" height="180" fill="#232a33" opacity="0.8"/>'),
    },
    '黄昏': {
        kw: ['黄昏', '夕阳', '傍晚', '落日', '晚霞'],
        art: G('g', '#e8934a', '#8a4a52',
            '<circle cx="225" cy="420" r="90" fill="#ffe3a0" opacity="0.95"/><rect x="0" y="560" width="450" height="240" fill="#4a2f3a" opacity="0.85"/><g fill="#31202a" opacity="0.9"><rect x="40" y="440" width="70" height="120"/><rect x="330" y="460" width="60" height="100"/></g>'),
    },
    // 古风 / 仙侠兜底。原本这类场景（某宗门东院、戒律堂、药堂…）
    // 一个都对不上，全被塞进「室内」——仙侠剧画成现代小屋。
    '古风': {
        kw: ['宗门', '山门', '外门', '内门', '长老', '师兄', '师姐', '宗主', '弟子', '灵石', '灵力',
            '丹药', '符', '阵法', '仙', '修', '殿', '阁', '堂', '院', '檐', '廊', '榻', '烛',
            '戒律', '刑', '药堂', '卷宗', '剑', '客栈', '坊市', '玄', '灵', '师门', '禁地'],
        art: G('g', '#3c4a63', '#1b2233',
            // 远山 + 云海
            '<path d="M0,430 L90,300 L150,360 L230,250 L310,350 L380,290 L450,380 L450,470 L0,470 Z" fill="#26314a" opacity="0.9"/>' +
            '<path d="M0,470 L120,390 L210,440 L300,370 L450,450 L450,520 L0,520 Z" fill="#1d2740" opacity="0.85"/>' +
            // 飞檐
            '<g fill="#141a28"><path d="M40,520 L60,455 L200,430 L210,470 L190,520 Z"/><path d="M250,520 L275,440 L430,420 L450,470 L440,520 Z"/></g>' +
            '<g stroke="#6f86b5" stroke-opacity="0.5" stroke-width="3" fill="none"><path d="M20,520 q40,-14 200,-18 q160,4 210,18"/></g>' +
            // 灯笼
            '<g fill="#e8a35a" opacity="0.85"><circle cx="120" cy="470" r="9"/><circle cx="330" cy="455" r="9"/></g>' +
            // 地面石板
            '<rect x="0" y="640" width="450" height="160" fill="#161c2b" opacity="0.92"/>'),
    },
};

// 这个场景名看起来像不像古风 / 仙侠（没有 SD 时用它挑兜底背景）
const ANCIENT_RE = /(宗|门|殿|阁|堂|院|寺|观|庙|府|楼|斋|轩|居|山|峰|崖|谷|洞|竹林|仙|修|灵|丹|符|阵|戒律|刑|药|卷宗|剑|客栈|坊市|玄|禁地|长老|师兄|师姐|弟子)/;

// 天气特效映射（CSS 类名）
function weatherOf(scene) {
    if (scene === '雨天') return 'rain';
    if (scene === '雪地') return 'snow';
    if (scene === '夜空') return 'night';
    return null;
}

// 场景 → 背景 URI（带缓存）
const _bgCache = new Map();
function sceneBG(scene) {
    let cat = SCENE_DEFS[scene] ? scene : null;
    if (!cat) cat = ANCIENT_RE.test(String(scene || '')) ? '古风' : '室内';
    if (_bgCache.has(cat)) return _bgCache.get(cat);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 450 800" preserveAspectRatio="xMidYMid slice">${SCENE_DEFS[cat].art}</svg>`;
    const uri = svgURI(svg);
    _bgCache.set(cat, uri);
    return uri;
}

// ---------- 智能场景猜测 ----------
function guessScene(text) {
    let best = null, bestHits = 0;
    for (const [cat, def] of Object.entries(SCENE_DEFS)) {
        let hits = 0;
        for (const kw of def.kw) if (text.includes(kw)) hits += kw.length >= 2 ? 1 : 0.5;
        if (hits > bestHits) { best = cat; bestHits = hits; }
    }
    return best;
}

// ---------- 剪影立绘 ----------
// 8 种表情的五官笔划（画在深色剪影上，浅色线条）
const EXPR_ART = {
    '平静': { eye: 'M92,150 q10,-5 20,0 M128,150 q10,-5 20,0', mouth: 'M110,178 q10,4 20,0', blush: '' },
    '微笑': { eye: 'M92,149 q10,-7 20,0 M128,149 q10,-7 20,0', mouth: 'M106,172 q14,11 28,0', blush: '' },
    '难过': { eye: 'M92,153 q10,5 20,0 M128,153 q10,5 20,0', mouth: 'M110,182 q10,-6 20,0', blush: '' },
    '生气': { eye: 'M96,146 l14,4 M130,150 l14,-4 M98,156 a4,4 0 1,0 0.1,0 M134,156 a4,4 0 1,0 0.1,0', mouth: 'M112,180 q8,-5 16,0', blush: '' },
    '惊讶': { eye: 'M98,150 a5,5 0 1,0 0.1,0 M134,150 a5,5 0 1,0 0.1,0', mouth: 'M112,176 a7,9 0 1,0 0.1,0', blush: '' },
    '害羞': { eye: 'M92,151 q10,5 20,0 M128,151 q10,5 20,0', mouth: 'M114,177 q6,4 12,0', blush: 'M88,164 a7,4 0 1,0 0.1,0 M136,164 a7,4 0 1,0 0.1,0' },
    '严肃': { eye: 'M94,150 h16 M130,150 h16', mouth: 'M110,179 h20', blush: '' },
    '得意': { eye: 'M92,148 q10,-3 20,0 M128,150 q10,-2 20,0', mouth: 'M106,174 q12,8 24,-3', blush: '' },
};
const EXPR_LIST = Object.keys(EXPR_ART);

const _silCache = new Map();
function silhouetteURI(name, expr) {
    const e = EXPR_ART[expr] || EXPR_ART['平静'];
    const key = name + '\u0000' + (EXPR_ART[expr] ? expr : '平静');
    if (_silCache.has(key)) return _silCache.get(key);
    const hue = hashStr(name) % 360;
    const body = `hsl(${hue}, 38%, 30%)`;
    const line = `hsl(${hue}, 65%, 82%)`;
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 340">` +
        `<path d="M14,340 C24,258 58,222 120,222 C182,222 216,258 226,340 Z" fill="${body}"/>` +
        `<circle cx="120" cy="152" r="60" fill="${body}"/>` +
        `<g stroke="${line}" stroke-width="3.5" fill="none" stroke-linecap="round" opacity="0.85">` +
        `<path d="${e.eye}"/><path d="${e.mouth}"/></g>` +
        (e.blush ? `<g fill="${line}" opacity="0.3"><ellipse cx="88" cy="164" rx="8" ry="4.5"/><ellipse cx="152" cy="164" rx="8" ry="4.5"/></g>` : '') +
        `</svg>`;
    const uri = svgURI(svg);
    _silCache.set(key, uri);
    return uri;
}

export { SCENE_DEFS, EXPR_LIST, sceneBG, weatherOf, guessScene, silhouetteURI, hashStr };
