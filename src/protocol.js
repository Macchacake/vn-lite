// ============================================
// protocol.js — 协议注入提示词（默认模板 + 用户自定义）
// 只描述输出格式：有哪些标签、怎么写、怎么收尾。
// 不附加主持人身份、写作风格、节奏、叙事守则或外观要求——
// 那些交给角色卡、世界书和玩家自己决定。
// ============================================

import { SCENE_DEFS, EXPR_LIST } from './assets.js';

const SCENE_NAMES = Object.keys(SCENE_DEFS).join('、');
const EXPR_NAMES = EXPR_LIST.join('、');

export const DEFAULT_PROTOCOL =
`【演出标签格式规范】
以下标签每个独占一行、写在方括号里，不要加引号、不要包进代码块。

可用标签及参数（| 为分隔符）：
[scene:场景]  场景只能是：${SCENE_NAMES}
[char:角色名|表情]  表情只能是：${EXPR_NAMES}
[bgm:氛围]  氛围只能是：平静、欢快、紧张、悲伤、温馨、神秘
[cg:英文画面描述]  一句英文，写主体、动作、场景、光线、情绪
[choice:选项A|选项B|选项C]  3~4 个选项
[input:提示语]  一句话
[dice:1d20|难度值|成功剧情|失败剧情]
[stats:标签|数值|标签|数值]  形如 80/100 的显示为血条
[item:+物品名x2] / [item:-物品名]
[quest:开始|任务名|描述] / [quest:完成|任务名] / [quest:失败|任务名]
[aff:角色名|+2]

格式要求：
- 每条回复的最后一行必须是 [choice:] 或 [input:]，写完即停。
- 每次换人说话前写一行 [char:角色名|表情]。
- 不要用 <think>、<bbs>、<game>、<options>、<details>、<comment>、<background> 等标签包裹正文。`;

export function buildProtocol(S) {
    const custom = S && typeof S.protocol === 'string' ? S.protocol.trim() : '';
    return custom || DEFAULT_PROTOCOL;
}

// 旧版内置协议（主持人守则 / 强制 [look:] / 叙事节奏）的特征串。
// 用户点过「填入当前协议」会把旧默认存进设置里，升级后必须清掉，
// 否则新默认永远被那段旧文本盖住。用户真正自己写的协议不含这些特征，会原样保留。
export function isLegacyProtocol(text) {
    return /文字冒险游戏演出规范|Game Master|主持守则|\[look:/.test(String(text || ''));
}
