'use strict';
// 「让鸿去@人 / 去某人私聊说话」的自然语言解析。
// 固定句式（src/onebot-main.js 的 parseDirectSay）快但死板，
// 这里补一层小模型：只要主人一句话表达了「去@谁 / 去跟谁说」，都认。
// 只在「主人 + 短句 + 像指令」时调用（平均多花 ~0.4s / ~150 token）。

/** 先粗筛：像不像在指挥她去@人 / 去私聊别人（挡掉日常聊天，省 token） */
const DIRECT_CUE = /[@＠]|私聊|发(?:个|条)?消息|告诉|转告|传话|传个话|带个话|带句话|喊一声|喊一下|叫一下|喊他|喊她|跟.{1,12}说|让.{1,12}说|提醒|说一句|帮我说|代我/;
const DIRECT_HEAD = /^(?:在|帮|给|让|叫|替我|麻烦|你去|去)/;

function looksLikeDirect(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return false;
  if (DIRECT_CUE.test(t)) return true;
  // 没有明显动词时，只认「在……群……」这类句子（「在吗」这种日常问候不能触发模型）
  return t.length >= 6 && /群/.test(t) && DIRECT_HEAD.test(t);
}

const SYSTEM = `你是指令解析器。主人可能让机器人做两件事之一：
1) 去某个群里 @ 某个人
2) 去某个人的私聊里说一句话

请从这句话里抽出：动作、对象、要说的内容、提到的群。只输出 JSON，不要解释。

动作 kind：
- "at"    去群里 @ 某人（例：在Bio人能飞里@Teto31、@一下张三、帮我喊一声李四、提醒张三交作业）
- "c2c"   去某人的私聊里说话（例：给张三发消息说饭吃了没、私聊李四告诉他明天放假、跟王五说一声我晚点到）
- "none"  不是这类指令（普通聊天、提问、让她自己说话、单纯提到某个人）

输出严格 JSON：
{"kind":"at","name":"对象名字","body":"要他说的那句话（没有就空串）","groupHint":"提到的群名或群号（没有就空串）"}

规则：
- name 必须尽量照抄「已知人物」里的叫法；实在找不到原样写你看到的名字。
- body 只留真正要说的话，不要把「帮我」「告诉」「说一声」这些动词带上。
- 只说 @ 人、没有要说的话时，body 给空串。`;

function parseJson(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** 群名洗一下：「群里的」「那个群」「这个群的」这种不算群名 */
function cleanGroupHint(s) {
  let g = String(s || '').trim();
  g = g.replace(/^(?:这个|那个|我们|咱们|你们的)?群?(?:里的|里|中的|中|的)?/, '').trim();
  g = g.replace(/(?:群里|群|里|中)$/, '').trim();
  if (!g || g === '群' || g.length > 20) return '';
  return g;
}

/**
 * 用模型解析「让她去@人 / 去私聊说话」的指令。
 * @returns {Promise<{kind:'at'|'c2c',name:string,body:string,groupHint:string}|null>}
 */
async function classifyDirectSay({ brain, text, names = [], timeoutMs = 6000 } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return null;
  if (!brain || typeof brain._complete !== 'function') return null;

  const known = (names || []).filter(Boolean).slice(0, 60).join('、');
  const messages = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `已知人物（备注/群名片/昵称，可能不完整）：${known || '（无）'}\n主人说：「${t}」`,
    },
  ];
  let raw = '';
  try {
    raw = await brain._complete(messages, 120, 0.1, { timeoutMs });
  } catch {
    return null;
  }
  const obj = parseJson(raw);
  if (!obj || !obj.kind) return null;
  const kind = obj.kind === 'at' || obj.kind === 'c2c' ? obj.kind : null;
  if (!kind) return null;
  const name = String(obj.name || '').trim().slice(0, 24);
  if (!name) return null;
  return {
    kind,
    name,
    body: String(obj.body || '').trim().slice(0, 280),
    groupHint: cleanGroupHint(obj.groupHint),
  };
}

module.exports = { DIRECT_CUE, looksLikeDirect, classifyDirectSay, cleanGroupHint, SYSTEM };
