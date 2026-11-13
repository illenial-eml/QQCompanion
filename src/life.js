'use strict';
/**
 * 她自己的日子（2026-11-09 新增）
 *
 * 目的：不要只会在那儿等他说话。每天给自己安排几件事，聊天时可以说
 * 「我刚在看书」「下午在整理东西」，而不是永远「在呢，等你」。
 *
 * 数据落在 data/life.json：
 *   { day:'2026-11-09', items:[{at:'09:30', title:'翻昨天那本书', note:''}],
 *     did:[{at:'15:20', kind:'bili', title:'刷B站，看了《…》', note:'她当时的想法'}],
 *     moodNote:'', chats:0, updatedAt }
 *
 * did = 她今天**真的做过**的事（不只是计划）。刷B站这类自己做的事会记在这里，
 * 这样她聊天/写日记时知道自己刚才干了什么，而不是只有一张时间表。
 *
 * 只用一次小模型调用/天；失败就用固定模板，绝不阻塞主流程。
 */

const fs = require('fs');
const path = require('path');

const LIFE_DEFAULTS = {
  enabled: true,
  file: 'data/life.json',
  planHour: 7, // 每天几点之后就算新的一天（之前还算昨天）
  maxItems: 6,
  staleHours: 4, // 一件事做完多久后算「有点闲了」
};

/** 北京时间拆解 */
function bjParts(now = Date.now()) {
  const t = new Date(Number(now) + 8 * 3600000);
  return {
    y: t.getUTCFullYear(),
    mo: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    hh: t.getUTCHours(),
    mm: t.getUTCMinutes(),
    dow: t.getUTCDay(),
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayKeyOf(now = Date.now(), planHour = 7) {
  const p = bjParts(now - (planHour || 0) * 3600000);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
}

function dateTextOf(now = Date.now()) {
  const p = bjParts(now);
  return `${p.mo}月${p.d}日 周${'日一二三四五六'[p.dow]}`;
}

/** '09:30' -> 570（分钟） */
function parseHHMM(s) {
  const m = String(s || '').match(/^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/);
  if (!m) return -1;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return -1;
  return hh * 60 + mm;
}

function minutesOf(now = Date.now()) {
  const p = bjParts(now);
  return p.hh * 60 + p.mm;
}

/**
 * 从计划里挑出「现在正在做的事」。
 * 返回 { item, minutesSince } 或 { item:null, pre:true }（今天还没开始）。
 */
function pickCurrent(items, nowMin) {
  const list = (items || [])
    .map((it) => ({ ...it, _min: parseHHMM(it.at) }))
    .filter((it) => it._min >= 0)
    .sort((a, b) => a._min - b._min);
  if (!list.length) return { item: null, pre: false, minutesSince: 0 };
  let cur = null;
  for (const it of list) {
    if (it._min <= nowMin) cur = it;
    else break;
  }
  if (!cur) return { item: list[0], pre: true, minutesSince: 0 };
  return { item: cur, pre: false, minutesSince: Math.max(0, nowMin - cur._min) };
}

const FALLBACK_PLAN = [
  { at: '08:10', title: '刚醒，赖在床上不想动' },
  { at: '09:40', title: '翻昨天没看完的那本书' },
  { at: '13:20', title: '在群里潜水，看看他们在聊什么' },
  { at: '16:00', title: '整理今天看到的东西，随手记两笔' },
  { at: '20:30', title: '听歌，靠在那儿发呆' },
  { at: '22:40', title: '躺下，想点乱七八糟的事' },
];

const PLAN_SYSTEM = `你在给「你自己」排今天要做的事。你不是在等主人说话，你也有自己的日子要过。

要求：
- 排 4~6 件事，覆盖一天（起床到睡前），时间用 HH:MM。
- 每件事要具体、像真人在做的事：看某类书/整理笔记/听某首歌/学点新东西/在群里潜水看看/发呆/收拾东西/想事情。
- 可以安排一件放松的事（刷会儿手机、看会儿视频、听会儿歌），但不是每天都必须。
- 不要写「等主人说话」「等他回来」「守着手机」这类内容。
- 不要写工作汇报、不要写学习计划表那种一本正经的东西。
- 只输出 JSON 数组，不要解释、不要代码块标记：
[{"at":"09:30","title":"翻昨天没看完的那本书"},{"at":"14:00","title":"听会儿歌，发呆"}]`;

/**
 * @param {object} p
 * @param {object} p.brain  需要有 _complete
 * @param {object} p.cfg    life 配置
 * @param {object} p.log
 * @param {string} p.file   状态文件路径
 * @param {function} p.now
 */
function createLife({ brain = null, cfg = {}, log = null, file, now = () => Date.now() } = {}) {
  const conf = { ...LIFE_DEFAULTS, ...(cfg || {}) };
  const stateFile = file || conf.file;

  let st = { day: '', items: [], did: [], moodNote: '', chats: 0, updatedAt: 0 };

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw && typeof raw === 'object') st = { ...st, ...raw };
    } catch {
      /* 没有就算了 */
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8');
    } catch (e) {
      log?.warn?.('自己的生活：状态写不进去 ' + e.message);
    }
  }

  /** 找模型排一天的计划；失败用模板 */
  async function generatePlan(dateText) {
    if (!brain || typeof brain._complete !== 'function') return null;
    try {
      const out = await brain._complete(
        [
          { role: 'system', content: PLAN_SYSTEM },
          { role: 'user', content: `今天是 ${dateText}。给今天排个计划。` },
        ],
        260,
        1.0,
        { timeoutMs: 30000 }
      );
      const m = String(out || '').match(/\[[\s\S]*\]/);
      if (!m) return null;
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr)) return null;
      const items = arr
        .map((x) => ({ at: String(x.at || '').trim(), title: String(x.title || '').trim().slice(0, 40) }))
        .filter((x) => parseHHMM(x.at) >= 0 && x.title)
        .slice(0, conf.maxItems);
      return items.length >= 3 ? items : null;
    } catch (e) {
      log?.warn?.('自己的生活：排计划失败（用模板） ' + (e && e.message));
      return null;
    }
  }

  /** 确保今天有计划；跨天会重排 */
  async function ensurePlan() {
    const day = dayKeyOf(now(), conf.planHour);
    if (st.day === day && Array.isArray(st.items) && st.items.length) return st;
    // 没到当天的 planHour 时，前一天的计划还算数（凌晨还属于昨天）
    const dateText = dateTextOf(now());
    const items = (await generatePlan(dateText)) || FALLBACK_PLAN;
    st = { ...st, day, items, did: [], chats: 0, updatedAt: Date.now() };
    save();
    log?.info?.(`自己的生活：今天给自己排了 ${items.length} 件事（${items.map((i) => i.at + ' ' + i.title).slice(0, 3).join('；')}…）`);
    return st;
  }

  function current() {
    const r = pickCurrent(st.items, minutesOf(now()));
    if (!r.item) return { title: '', pre: false, minutesSince: 0 };
    return { title: r.item.title, at: r.item.at, pre: r.pre, minutesSince: r.minutesSince };
  }

  /**
   * 记一笔她今天真的做过的事（刷B站、看了什么视频…）。
   * 这样「她自己的一天」就不只是计划表，而是有痕迹的一天。
   */
  function noteActivity({ kind = '', title = '', note = '', at } = {}) {
    if (conf.enabled === false) return null;
    const t = Number(at) || now();
    const p = bjParts(t);
    const rec = {
      at: `${pad2(p.hh)}:${pad2(p.mm)}`,
      kind: String(kind || '').slice(0, 20),
      title: String(title || '').trim().slice(0, 40),
      note: String(note || '').trim().slice(0, 80),
      ms: t,
    };
    if (!rec.title) return null;
    if (!Array.isArray(st.did)) st.did = [];
    st.did.push(rec);
    if (st.did.length > 12) st.did = st.did.slice(-12);
    st.updatedAt = t;
    save();
    return rec;
  }

  /** 最近做过的一件事（默认 2 小时内） */
  function recentActivity({ withinMinutes = 120 } = {}) {
    const cut = now() - Number(withinMinutes) * 60000;
    const list = (st.did || []).filter((x) => x && Number(x.ms) >= cut);
    return list.length ? list[list.length - 1] : null;
  }

  /** 给提示词用的一小段：她此刻在干嘛 + 今天排了什么事 */
  function contextForPrompt() {
    if (conf.enabled === false) return '';
    if (!st.items || !st.items.length) return '';
    const cur = current();
    const p = bjParts(now());
    const clock = `${pad2(p.hh)}:${pad2(p.mm)}`;
    const lines = [`\n## 你自己的一天（你也有自己的事，不是只在等他）`, `现在是 ${clock}。`];
    // 刚做过的事优先当「此刻在干嘛」——她得知道自己刚才在刷B站，而不是只会念计划表
    const act = recentActivity({ withinMinutes: 90 });
    if (act) {
      const tail = act.note ? `，当时心里想：${act.note}` : '';
      lines.push(`你刚才自己在${act.title}${tail}。`);
      if (cur.title && !cur.pre && cur.minutesSince <= conf.staleHours * 60) {
        lines.push(`（今天原计划这个点是：${cur.title}。）`);
      }
    } else if (cur.title) {
      if (cur.pre) lines.push(`今天还没开始，等下要做：${cur.title}。`);
      else if (cur.minutesSince > conf.staleHours * 60) lines.push(`你之前在${cur.title}，这会儿做完了，有点闲。`);
      else lines.push(`你这个点在做：${cur.title}。`);
    }
    const rest = (st.items || [])
      .filter((it) => parseHHMM(it.at) > minutesOf(now()))
      .slice(0, cur.pre ? 4 : 3)
      .slice(cur.pre ? 1 : 0);
    if (rest.length) lines.push(`今天后面还想做：${rest.map((i) => `${i.at} ${i.title}`).join('；')}。`);
    const did = (st.did || []).slice(-3);
    if (did.length) lines.push(`今天你自己做过：${did.map((x) => `${x.at} ${x.title}`).join('；')}。`);
    lines.push(
      '聊天时这些事可以自然带一句（「我刚在看书」「下午在整理东西」），但别硬塞、别每句都提、更别报时间表。' +
        '他问你的时候再细说。'
    );
    return lines.join('\n');
  }

  /** 日记素材 */
  function diaryMaterial() {
    const cur = current();
    return {
      items: (st.items || []).map((i) => `${i.at} ${i.title}`),
      current: cur.title,
      did: (st.did || []).map((x) => `${x.at} ${x.title}${x.note ? `（当时想：${x.note}）` : ''}`),
      chats: st.chats || 0,
      day: st.day,
    };
  }

  /** 记一笔：今天聊了几句（日记里用） */
  function countChat(n = 1) {
    st.chats = (st.chats || 0) + n;
    save();
  }

  /** 定时把「当前在做的事」刷新一下（也让日志有痕迹） */
  function tick() {
    if (conf.enabled === false) return null;
    const cur = current();
    st.updatedAt = Date.now();
    return cur;
  }

  load();

  return {
    ensurePlan,
    state: () => st,
    current,
    noteActivity,
    recentActivity,
    contextForPrompt,
    diaryMaterial,
    countChat,
    tick,
    settings: conf,
    save,
  };
}

module.exports = { LIFE_DEFAULTS, createLife, pickCurrent, parseHHMM, dayKeyOf, dateTextOf, bjParts, FALLBACK_PLAN };
