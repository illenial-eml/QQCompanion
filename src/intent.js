'use strict';
// 自然语言意图识别：不靠固定句式，让模型把人话归成几个动作。
// 只在「主人私聊 + 文本命中关键词」时调用，平均每条多花 ~0.4s、~150 token。
const INTENT_HINTS = /日程|安排|提醒|课表|课程|考试|印象|计划|备忘|待办|记得|忘|认识|聊过/;

const INTENTS = [
  'schedule_list', // 看日程（今天/明天/本周/全部）
  'schedule_add', // 加日程（文本里已含时间就交给已有解析器）
  'schedule_delete', // 删日程（按序号/关键词）
  'timetable_view', // 看课表（整周）
  'timetable_day', // 看某天课
  'exam_list', // 看考试
  'people_list', // 看印象库
  'none', // 其它
];

const SYSTEM = `你是意图分类器。把用户这句话归到一个动作，只输出 JSON，不要解释。

可选动作：
- schedule_list：想看已有的日程/提醒/安排（例：我今天的日程、明天有啥安排、我都有哪些提醒、这周忙不忙）
- schedule_add：想新加一个日程/提醒（例：明天九点提醒我开会）
- schedule_delete：想删掉某个日程/提醒（例：删掉第二条、取消开会那个）
- timetable_view：想看整周课程表（例：课表、这周上什么课）
- timetable_day：想看某天的课（例：明天有课吗、今天上什么）
- exam_list：想看考试安排（例：什么时候考试、最近有啥考试）
- people_list：想看她对别人的印象（例：你认识谁、你对某某印象怎么样）
- none：跟上面都无关

输出格式（严格 JSON，不要多余字符）：
{"intent":"schedule_list","when":"today|tomorrow|dayafter|week|all","index":0,"keyword":"","name":""}
没有的字段给空字符串或 0。`;

function parseJson(text) {
  if (!text) return null;
  const s = String(text).trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{intent:string, when?:string, index?:number, keyword?:string, name?:string}|null>}
 */
async function classifyIntent({ brain, text, timeoutMs = 12000 } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > 120) return null;
  if (!INTENT_HINTS.test(t)) return null;
  if (!brain || typeof brain._complete !== 'function') return null;

  const nowText = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `当前北京时间：${nowText}\n用户说：「${t}」` },
  ];
  let raw = '';
  try {
    raw = await brain._complete(messages, 120, 0.1, { timeoutMs });
  } catch {
    return null;
  }
  const obj = parseJson(raw);
  if (!obj || !obj.intent) return null;
  const intent = INTENTS.includes(obj.intent) ? obj.intent : 'none';
  if (intent === 'none') return { intent: 'none' };
  return {
    intent,
    when: typeof obj.when === 'string' ? obj.when : '',
    index: Number(obj.index) || 0,
    keyword: typeof obj.keyword === 'string' ? obj.keyword.slice(0, 20) : '',
    name: typeof obj.name === 'string' ? obj.name.slice(0, 20) : '',
  };
}

module.exports = { INTENT_HINTS, INTENTS, classifyIntent, parseJson, SYSTEM };
