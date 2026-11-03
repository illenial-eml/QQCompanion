'use strict';
/**
 * 日程提醒（只给主人用）
 *
 * 主人私聊说一句「明天早上 9 点提醒我开会」，它记下来，到点私聊发提醒。
 * 全程不经过模型：省 token、也不会因为模型抽风漏提醒。
 *
 * 支持的说法（北京时间 Asia/Shanghai）：
 *   明天早上9点 / 明天9点 / 今晚8点半 / 下午3点 / 中午12点 / 晚上十点
 *   30分钟后 / 半小时后 / 2小时后 / 3天后 / 周五下午3点 / 下周一9点
 *   明早7点、后天下午两点、10月30日 9点
 *
 * 管理命令（由 responder 解析，本文件提供底层能力）：
 *   「我的提醒」          列出（带编号）
 *   「取消提醒」          撤掉最近一条
 *   「删除第2条」         按编号删
 *   「取消全部提醒」      清空
 *   「删掉开会那个」      按关键词删
 *
 * 2026-10-28 大修：
 *   1) 收紧「要不要记」的判断——以前只要句子里有「提醒/记得」，又恰好带个时间，
 *      就会记一条日程（用户反馈「会乱加日程」）。现在必须有明确的「让我提醒你」的
 *      请求语气才认。
 *   2) 支持按编号/关键词删除、清空（以前只能删最近一条，用户反馈「不能删除」）。
 *   3) 到点发送失败不再直接标记完成（以前发失败也算发过，用户反馈「不提醒」）。
 *
 * 文件名：data/reminders.json
 */

const fs = require('fs');
const path = require('path');

const REMINDER_DEFAULTS = {
  enabled: true,
  tickMs: 20000,          // 每 20 秒检查一次到点
  maxPending: 50,         // 最多挂 50 条
  timezoneOffsetHours: 8, // 北京时间
  keepHistoryDays: 2,     // 已发的留 2 天方便排查
  maxRetry: 6,            // 发送失败最多重试几次（20s * 6 ≈ 2 分钟）
  lateGraceHours: 12,     // 超过这么久还没发出去（比如手机一直关着）就不再补发
};

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};

// 把「九」「十二」「二十三」「十五」「二十五」转成数字；纯阿拉伯数字直接过
function toNumber(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s.includes('半')) return null; // 「半」由调用方单独处理
  const m = s.match(/^([零〇一二两三四五六七八九])?十([零〇一二三四五六七八九])?$/);
  if (m) {
    const tens = m[1] === undefined ? 1 : CN_DIGITS[m[1]];
    const ones = m[2] === undefined ? 0 : CN_DIGITS[m[2]];
    if (tens === undefined || ones === undefined) return null;
    return tens * 10 + ones;
  }
  if (s.length === 1 && CN_DIGITS[s] !== undefined) return CN_DIGITS[s];
  let total = 0;
  let hasCn = false;
  for (const ch of s) {
    if (CN_DIGITS[ch] !== undefined) {
      total = total * 10 + CN_DIGITS[ch];
      hasCn = true;
    } else {
      return null;
    }
  }
  return hasCn ? total : null;
}

const NUM = '(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})';

// 时间段 → 小时基数（非锚定，兼容「今晚11点」）
const PERIOD_RULES = [
  [/(凌晨)/, 0],
  [/(早上|早晨|上午|清晨|大清早)/, 0],
  [/(中午|正午|晌午)/, 12],
  [/(下午|午后)/, 12],
  [/(傍晚|晚上|夜里|夜间|晚间|今晚|明晚)/, 12],
];

const WEEK_CN = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/**
 * 「要不要记这条日程」的判断（很重要，防乱加）
 * 只有出现明确的「让你提醒我」请求才算，闲聊里提一句「提醒」不算。
 */
const REQUEST_PATTERNS = [
  /提醒我/,
  /(?:帮我|给我)?(?:设|定|加|记|建)(?:个|一个|一条)?(?:提醒|日程|闹钟)/,
  /(?:设|定|加|记|建|安排).{0,14}(?:提醒|闹钟|日程)/,
  /提醒一下/,
  /叫我(?:起床|一声|一下)/,
  /别忘(?:了)?(?:提醒|叫我)/,
];

/** 明显是「别人的事/假设/发问」，不当日程 */
const REJECT_PATTERNS = [
  /(?:你|他|她|它)(?:不是|没有|不会|有没有)(?:提醒|记得)/,
  /提醒(?:他|她|它)/,
  /(?:提醒|记得).{0,6}(?:吗|呢|吧)[？?]?$/,
  /(?:是不是|要不要|能不能|可不可以)(?:提醒|记得)/,
];

/**
 * 重复规则（2026-10-28 新增）
 *   每周三晚8点提醒我开会   → { kind:'weekly', wd:3, h:20, mi:0 }
 *   每天9点提醒我吃药       → { kind:'daily', h:9, mi:0 }
 *   每月15号提醒我交房租     → { kind:'monthly', d:15, h:9, mi:0 }
 * 返回 null 表示不是重复日程（一次性）。
 */
function parseRepeat(raw) {
  const s = String(raw || '');
  const t = s.match(new RegExp(`${NUM}\\s*[点時时]\\s*(半|${NUM}分?)?`));
  let h = 9;
  let mi = 0;
  if (t) {
    const hh = toNumber(t[1]);
    if (hh !== null) h = hh;
    if (t[2] === '半') mi = 30;
    else if (t[2]) { const mm = toNumber(String(t[2]).replace('分', '')); if (mm !== null) mi = mm; }
    if (h < 12) {
      if (/(中午|正午|晌午)/.test(s)) { if (h < 9) h += 12; } else {
        let hit = false;
        for (const [re, base] of PERIOD_RULES) { if (re.test(s)) { h += base; hit = true; break; } }
        // 「晚8点」「夜里11点」这种只说一个「晚」字的
        if (!hit && /[晚夜]/.test(s)) h += 12;
      }
    }
    if (h >= 24) h -= 24;
  }
  if (/(每天|每日|天天)/.test(s)) return { kind: 'daily', h, mi };
  // 必须带「每」才算重复：「这周五」是本周五（一次性），「每周五」才是重复
  const w = s.match(/(?:每(?:个)?)(?:周|星期|礼拜)([一二三四五六日天])/);
  if (w) return { kind: 'weekly', wd: WEEK_CN[w[1]], h, mi };
  const d = s.match(/(?:每(?:个)?月|每月)\s*(\d{1,2})\s*[日号]/);
  if (d) {
    const dd = Number(d[1]);
    if (dd >= 1 && dd <= 31) return { kind: 'monthly', d: dd, h, mi };
  }
  return null;
}

/** 下一次触发时间（严格大于 from） */
function nextOccurrence(rep, from = Date.now()) {
  if (!rep) return null;
  const p = bjParts(from);
  const cand = [];
  if (rep.kind === 'daily') {
    cand.push(bjToMs(p.y, p.mo, p.d, rep.h, rep.mi));
    cand.push(bjToMs(p.y, p.mo, p.d + 1, rep.h, rep.mi));
  } else if (rep.kind === 'weekly') {
    const t = bjParts(from);
    const delta = ((rep.wd - t.wd) + 7) % 7;
    cand.push(bjToMs(p.y, p.mo, p.d + delta, rep.h, rep.mi));
    cand.push(bjToMs(p.y, p.mo, p.d + delta + 7, rep.h, rep.mi));
  } else if (rep.kind === 'monthly') {
    cand.push(bjToMs(p.y, p.mo, rep.d, rep.h, rep.mi));
    cand.push(bjToMs(p.y, p.mo + 1, rep.d, rep.h, rep.mi));
  }
  const v = cand.filter((x) => x > from).sort((a, b) => a - b);
  return v[0] || null;
}

function repeatText(rep) {
  if (!rep) return '';
  const hm = `${pad2(rep.h)}:${pad2(rep.mi)}`;
  if (rep.kind === 'daily') return `每天 ${hm}`;
  if (rep.kind === 'weekly') return `每周${'日一二三四五六'[rep.wd] || ''} ${hm}`;
  if (rep.kind === 'monthly') return `每月 ${rep.d} 号 ${hm}`;
  return '';
}

function isReminderRequest(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (s.length > 120) return false;                 // 太长的当聊天，不抢
  if (REJECT_PATTERNS.some((re) => re.test(s))) return false;
  // 「提醒我」是最强信号，直接认
  if (/提醒我/.test(s)) return true;
  // 其它要求必须同时提到「提醒/日程/闹钟/叫我」
  if (!/(提醒|日程|闹钟|叫我)/.test(s)) return false;
  return REQUEST_PATTERNS.some((re) => re.test(s));
}

function pad2(n) { return String(n).padStart(2, '0'); }
function bjToMs(y, mo, d, h, mi) { return Date.UTC(y, mo - 1, d, h - 8, mi, 0, 0); }

function bjParts(ms) {
  const t = new Date(ms + 8 * 3600 * 1000);
  return {
    y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(),
    h: t.getUTCHours(), mi: t.getUTCMinutes(), wd: t.getUTCDay(),
  };
}

function fmt(ms) {
  const p = bjParts(ms);
  const wd = ['日', '一', '二', '三', '四', '五', '六'][p.wd];
  return `${p.mo}月${p.d}日 周${wd} ${pad2(p.h)}:${pad2(p.mi)}`;
}

/** 相对说法：「还有 2 小时」 */
function fmtIn(at, now = Date.now()) {
  const d = at - now;
  if (d < 0) return '已经过点了';
  const m = Math.round(d / 60000);
  if (m < 1) return '就在这一刻';
  if (m < 60) return `${m} 分钟后`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h} 小时 ${mm} 分钟后` : `${h} 小时后`;
  return `${Math.floor(h / 24)} 天后`;
}

/**
 * 解析一句提醒
 * @returns {{at:number, human:string, body:string}|null}
 */
function parseReminder(text, now = Date.now()) {
  // 「11: 40」「9 : 30」这种中间带空格的先归一，否则既认不出时间、正文里也擦不干净
  const raw = String(text || '').trim().replace(/(\d{1,2})\s*[:：]\s*(\d{1,2})/g, '$1:$2');
  if (!raw) return null;
  if (!isReminderRequest(raw)) return null;

  // ---- 重复日程（每天 / 每周X / 每月N号）----
  const rep = parseRepeat(raw);
  if (rep) {
    const at = nextOccurrence(rep, now);
    if (!at) return null;
    let rbody = raw
      .replace(/(?:每天|每日|天天)/g, ' ')
      .replace(/(?:每(?:个)?)?(?:周|星期|礼拜)[一二三四五六日天]/g, ' ')
      .replace(/(?:每(?:个)?月)\s*\d{1,2}\s*[日号]/g, ' ')
      .replace(new RegExp(`${NUM}\\s*[点時时]\\s*(?:半|${NUM}分?)?`), ' ')
      .replace(/(?:凌晨|早上|早晨|上午|清晨|中午|正午|下午|午后|傍晚|晚上|晚间|夜里|夜间|晚|夜)/g, ' ')
      .replace(/(?:帮我|给我)?(?:设|定|加|记|建)(?:个|一个|一条)?(?:提醒|日程|闹钟)/g, ' ')
      .replace(/(?:记得)?(?:提醒|叫)我?/g, ' ')
      .replace(/(?:一下|一声)/g, ' ')
      .replace(/[，,。.!！?？~～、:：]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (rbody.length > 60) rbody = rbody.slice(0, 60) + '…';
    if (!rbody) rbody = '（没说具体内容）';
    return { at, human: fmt(at), body: rbody, repeat: rep };
  }

  const nowP = bjParts(now);
  let at = null;

  // ---- 相对时间 ----
  let m = raw.match(new RegExp(`(?:过|再)?\\s*${NUM}\\s*分钟(?:之)?后`));
  if (m) { const n = toNumber(m[1]); if (n) at = now + n * 60000; }
  if (!at && /半小时(?:之)?后/.test(raw)) at = now + 30 * 60000;
  if (!at && /(?:一|1)?个半?小时(?:之)?后/.test(raw) && !/半(?:个)?小时/.test(raw)) {
    // 「一个小时后」≠「一个半小时后」
    const mm = raw.match(new RegExp(`(?:过|再)?\\s*${NUM}\\s*(?:个)?半?小时(?:之)?后`));
    if (mm) { const n = toNumber(mm[1]); if (n) at = now + n * 3600000; }
  }
  if (!at) {
    m = raw.match(new RegExp(`(?:过|再)?\\s*${NUM}\\s*(?:个)?小时(?:之)?后`));
    if (m) { const n = toNumber(m[1]); if (n) at = now + n * 3600000; }
  }
  if (!at) {
    m = raw.match(new RegExp(`${NUM}\\s*天(?:之)?后`));
    if (m) { const n = toNumber(m[1]); if (n) at = now + n * 86400000; }
  }
  if (!at && /(?:一会(?:儿)?|待会(?:儿)?|马上)后/.test(raw)) at = now + 10 * 60000;

  // ---- 绝对时间 ----
  if (!at) {
    let dayOffset = 0;
    let explicitDay = false;
    if (/大后天/.test(raw)) { dayOffset = 3; explicitDay = true; }
    else if (/后天/.test(raw)) { dayOffset = 2; explicitDay = true; }
    else if (/明天|明早|明晚|明日/.test(raw)) { dayOffset = 1; explicitDay = true; }
    else if (/今天|今晚|今早|今日/.test(raw)) { dayOffset = 0; explicitDay = true; }

    // 周几：周三 / 星期三 / 礼拜五 / 下周一
    if (!explicitDay) {
      const wm = raw.match(/(下+)?(?:周|星期|礼拜)([一二三四五六日天])/);
      if (wm) {
        const target = WEEK_CN[wm[2]];
        const nextWeek = Boolean(wm[1]);
        let delta = (target - nowP.wd + 7) % 7;
        const untilSunday = (7 - nowP.wd) % 7;   // 距离本周日还有几天
        if (delta === 0) delta = 7;              // 说「周三」当天 → 算下周
        else if (nextWeek && delta <= untilSunday) delta += 7; // 「下周三」如果还落在本周就顺延
        dayOffset = delta;
        explicitDay = true;
      }
    }

    // 具体日期：10月30日 / 10/30
    let mdMonth = null;
    let mdDay = null;
    const dm = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
    if (dm) { mdMonth = Number(dm[1]); mdDay = Number(dm[2]); }
    if (mdMonth === null) {
      const dm2 = raw.match(/(?<![\d:])(\d{1,2})\s*[/-]\s*(\d{1,2})(?![\d:])/);
      if (dm2) { mdMonth = Number(dm2[1]); mdDay = Number(dm2[2]); }
    }

    // 小时/分钟
    let hour = null;
    let minute = 0;
    m = raw.match(new RegExp(`${NUM}\\s*[点時时]\\s*(半|${NUM}分?)?`));
    if (m) {
      hour = toNumber(m[1]);
      if (m[2] === '半') minute = 30;
      else if (m[2]) { const mm = toNumber(String(m[2]).replace('分', '')); if (mm !== null) minute = mm; }
    }
    if (hour === null) {
      m = raw.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
      if (m) { hour = Number(m[1]); minute = Number(m[2]); }
    }

    if (hour !== null || mdMonth !== null || dayOffset > 0) {
      if (hour !== null && hour < 12) {
        // 「中午」不是统统一律 +12：「中午11:40」还是 11:40，「中午1点」才是 13:00
        if (/(中午|正午|晌午)/.test(raw)) {
          if (hour < 9) hour += 12;
        } else {
          for (const [re, base] of PERIOD_RULES) { if (re.test(raw)) { hour += base; break; } }
        }
      }
      if (hour !== null && hour >= 24) hour -= 24;
      const hh = hour === null ? 9 : hour;           // 只说了日期没说时间 → 默认早上 9 点
      const baseMs = Date.UTC(nowP.y, nowP.mo - 1, nowP.d, 0, 0, 0, 0) - 8 * 3600000;
      const base = bjParts(baseMs);
      if (mdMonth !== null) {
        at = bjToMs(base.y, mdMonth, mdDay, hh, minute);
        if (at <= now) at = bjToMs(base.y + 1, mdMonth, mdDay, hh, minute);
      } else {
        at = bjToMs(base.y, base.mo, base.d + dayOffset, hh, minute);
        if (at <= now && dayOffset === 0) at += 86400000;
      }
    }
  }

  if (!at || at <= now) return null;
  if (at - now > 400 * 86400000) return null; // 太远了不认

  // 提醒内容：去掉时间短语和命令词
  let body = raw
    .replace(/^(?:请|麻烦)?(?:你)?/, '')
    .replace(/(?:这|那|本|下+|上)?(?:周|星期|礼拜)[一二三四五六日天]/g, ' ')
    .replace(new RegExp(`\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]?`, 'g'), ' ')
    .replace(/(?<![\d:])\d{1,2}\s*[/-]\s*\d{1,2}(?![\d:])/g, ' ')
    .replace(new RegExp(`${NUM}\\s*[点時时]\\s*(?:半|${NUM}分?)?`), ' ')
    .replace(/\d{1,2}[:：]\d{1,2}/g, ' ')
    .replace(/(?:大后天|后天|明天|明早|明晚|明日|今天|今晚|今早|今日)/g, ' ')
    .replace(/(?:凌晨|早上|早晨|上午|清晨|中午|正午|下午|午后|傍晚|晚上|夜里|晚间)/g, ' ')
    .replace(/(?:过|再)?\s*\d{1,2}\s*(?:分钟|小时|天)(?:之)?后/g, ' ')
    .replace(/(?:一|1)?个半(?:小)?时(?:之)?后/g, ' ')
    .replace(/半小时(?:之)?后/g, ' ')
    .replace(/(?:一会(?:儿)?|待会(?:儿)?)后/g, ' ')
    .replace(/(?:帮我|给我)?(?:设|定|加|记|建)(?:个|一个|一条)?(?:提醒|日程|闹钟)/g, ' ')
    .replace(/(?:记得)?(?:提醒|叫)我?/g, ' ')
    .replace(/(?:一下|一声)/g, ' ')
    .replace(/[，,。.!！?？~～、:：]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (body.length > 60) body = body.slice(0, 60) + '…';
  if (!body) body = '（没说具体内容）';

  return { at, human: fmt(at), body };
}

function createReminderStore({ file, cfg = {}, log = null, now = Date.now } = {}) {
  const conf = { ...REMINDER_DEFAULTS, ...(cfg || {}) };
  let state = { items: [] };
  try {
    if (file && fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log?.warn?.('读提醒列表失败，当成空的:', e.message);
  }
  if (!Array.isArray(state.items)) state.items = [];

  let seq = state.items.reduce((mx, it) => Math.max(mx, Number(it.id) || 0), 0);

  function save() {
    try {
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 1));
    } catch (e) {
      log?.warn?.('存提醒列表失败:', e.message);
    }
  }

  function cleanup(t = now()) {
    const keepMs = conf.keepHistoryDays * 86400000;
    const before = state.items.length;
    state.items = state.items.filter((it) => !it.doneAt || (t - it.doneAt) < keepMs);
    if (state.items.length !== before) save();
  }

  function add({ at, body, human, by = 'owner', repeat = null }) {
    const pending = state.items.filter((it) => !it.doneAt).length;
    if (pending >= conf.maxPending) return { ok: false, reason: 'too-many' };
    const item = { id: ++seq, at, body, human, by, repeat, createdAt: now(), doneAt: 0, tries: 0 };
    state.items.push(item);
    cleanup();
    save();
    return { ok: true, item };
  }

  /**
   * 重复日程到点后，把「下一次」排进去（2026-10-28 新增）
   * 返回新条目；不是重复日程则返回 null。
   */
  function reschedule(item) {
    if (!item || !item.repeat) return null;
    const next = nextOccurrence(item.repeat, item.at + 60000);
    if (!next) return null;
    const r = add({ at: next, body: item.body, human: fmt(next), by: item.by || 'owner', repeat: item.repeat });
    return r.ok ? r.item : null;
  }

  function listPending() {
    return state.items.filter((it) => !it.doneAt).sort((a, b) => a.at - b.at);
  }

  /** 到点未发的提醒（按时间升序） */
  function due(t = now()) {
    const graceMs = (conf.lateGraceHours || 12) * 3600000;
    return listPending().filter((it) => it.at <= t && (t - it.at) <= graceMs);
  }

  /** 超期太久、已经没必要补发的（标完成，避免一直挂着） */
  function expireStale(t = now()) {
    const graceMs = (conf.lateGraceHours || 12) * 3600000;
    let n = 0;
    for (const it of state.items) {
      if (!it.doneAt && it.at <= t && (t - it.at) > graceMs) { it.doneAt = t; it.expired = true; n += 1; }
    }
    if (n) save();
    return n;
  }

  function markDone(id, t = now()) {
    const it = state.items.find((x) => x.id === id);
    if (!it) return false;
    it.doneAt = t;
    save();
    return true;
  }

  function bumpTry(id) {
    const it = state.items.find((x) => x.id === id);
    if (it) { it.tries = (it.tries || 0) + 1; save(); }
    return it ? it.tries : 0;
  }

  /** 取消：最近一条 */
  function cancelLast() {
    const p = listPending();
    if (!p.length) return null;
    const last = p[p.length - 1];
    state.items = state.items.filter((x) => x.id !== last.id);
    save();
    return last;
  }

  /** 按 id 取消 */
  function cancelById(id) {
    const it = listPending().find((x) => x.id === Number(id));
    if (!it) return null;
    state.items = state.items.filter((x) => x.id !== it.id);
    save();
    return it;
  }

  /**
   * 按「第 N 条」取消（N 从 1 开始，按时间排序，和列表顺序一致）
   */
  function cancelByIndex(n) {
    const p = listPending();
    const it = p[Number(n) - 1];
    if (!it) return null;
    state.items = state.items.filter((x) => x.id !== it.id);
    save();
    return it;
  }

  /** 按关键词取消（匹配正文或时间描述） */
  function cancelByKeyword(kw) {
    const k = String(kw || '').trim();
    if (!k) return null;
    const p = listPending();
    const hit = p.find((x) => (x.body || '').includes(k) || (x.human || '').includes(k));
    if (!hit) return null;
    state.items = state.items.filter((x) => x.id !== hit.id);
    save();
    return hit;
  }

  /** 清空所有未发提醒 */
  function cancelAll() {
    const p = listPending();
    state.items = state.items.filter((x) => x.doneAt);
    save();
    return p;
  }

  /**
   * 到点发送。
   * onDue 返回 false / 抛错 → 不标记完成，下个 tick 重试（最多 maxRetry 次）。
   */
  function start({ onDue, intervalMs = conf.tickMs } = {}) {
    cleanup();
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        cleanup();
        expireStale();
        const items = due();
        for (const it of items) {
          let ok = false;
          try {
            ok = (await onDue?.(it)) !== false;
          } catch (e) {
            log?.warn?.('提醒发送失败:', e.message);
          }
          if (ok) {
            markDone(it.id);
            log?.info?.(`日程提醒：已发出 #${it.id} 「${it.body}」`);
            const nx = reschedule(it);
            if (nx) log?.info?.(`日程提醒：重复日程已排下一次 #${nx.id}（${nx.human}）`);
          } else {
            const tries = bumpTry(it.id);
            log?.warn?.(`日程提醒：发送失败 #${it.id}（第 ${tries} 次），等下次重试`);
            if (tries >= (conf.maxRetry || 6)) {
              markDone(it.id);
              log?.warn?.(`日程提醒：放弃 #${it.id}（重试 ${tries} 次都失败）`);
            }
          }
        }
      } catch (e) {
        log?.warn?.('提醒调度出错:', e.message);
      } finally {
        running = false;
      }
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** 启动时：把「已经过点但还没发」的列出来（用来补发/告知） */
  function overdue(t = now()) {
    return listPending().filter((it) => it.at <= t);
  }

  return {
    cfg: conf, add, listPending, due, overdue, expireStale, markDone, bumpTry,
    cancelLast, cancelById, cancelByIndex, cancelByKeyword, cancelAll,
    start, save, fmt, fmtIn, reschedule,
  };
}

module.exports = {
  REMINDER_DEFAULTS, createReminderStore, parseReminder, fmt, fmtIn,
  toNumber, isReminderRequest, parseRepeat, nextOccurrence, repeatText,
};
