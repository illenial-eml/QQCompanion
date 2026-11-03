'use strict';
/**
 * 每周课表：把一学期的固定课程存下来，每节课前 N 分钟提醒。
 *
 * 为什么单独做而不是塞进 reminders.js：
 *   reminders 是「一次性事件」（10月30日 14:00 开会），课表是「每周循环 + 单双周」，
 *   而且判断条件多一个「这周是第几周」。混在一起会让两边的解析都变糊。
 *
 * 数据文件 data/timetable.json：
 *   { semesterStart: '2026-09-07', remindBeforeMin: 10,
 *     sessions: [ { day: 1, periods: [5,6], name: '普通生物学', place: '理教106', parity: 'all'|'odd'|'even', note: '' } ] }
 */
const fs = require('fs');
const path = require('path');

const TIMETABLE_DEFAULTS = {
  enabled: true,
  remindBeforeMin: 10,   // 提前几分钟提醒
  tickMs: 30000,         // 每 30 秒查一次
  quietHours: [0, 1, 2, 3, 4, 5, 6], // 这些小时不主动推（半夜的课不提醒）
  semesterStart: null,   // 第 1 周周一（YYYY-MM-DD），用来算单双周
};

// 北大作息（第一节到第十二节）。学校不同就改这里，或直接改 data/timetable.json 里的秒级时间。
const SECTION_TIMES = [
  ['08:00', '08:50'],
  ['09:00', '09:50'],
  ['10:10', '11:00'],
  ['11:10', '12:00'],
  ['13:00', '13:50'],
  ['14:00', '14:50'],
  ['15:10', '16:00'],
  ['16:10', '17:00'],
  ['17:10', '18:00'],
  ['18:40', '19:30'],
  ['19:40', '20:30'],
  ['20:40', '21:30'],
];

const WEEK_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PARITY_CN = { all: '', odd: '（单周）', even: '（双周）' };

const BJ = 8 * 3600 * 1000;

function hhmmToMin(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minToHhmm(n) {
  const x = ((Math.round(n) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}

/** 北京时间的「第几天」（按本地日界切） */
function dayKeyBJ(ms) {
  return Math.floor((ms + BJ) / 86400000);
}

/** 星期几：1=周一 … 7=周日 */
function wdOf(ms) {
  return ((dayKeyBJ(ms) + 3) % 7) + 1;
}

/** 某天的 00:00（北京）对应的毫秒 */
function startOfDayBJ(ms) {
  const k = dayKeyBJ(ms);
  return k * 86400000 - BJ;
}

function ymdOf(ms) {
  const d = new Date(startOfDayBJ(ms) + 12 * 3600 * 1000); // 加 12 小时防时区漂
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseYmd(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - BJ;
}

function sessionSpan(sec) {
  const p = Array.isArray(sec.periods) ? sec.periods : [];
  const a = SECTION_TIMES[Math.max(0, (p[0] || 1) - 1)] || ['08:00', '08:50'];
  const b = SECTION_TIMES[Math.max(0, (p[p.length - 1] || 1) - 1)] || a;
  return { startMin: hhmmToMin(a[0]), endMin: hhmmToMin(b[1]), start: a[0], end: b[1] };
}

function periodsText(sec) {
  const p = sec.periods || [];
  if (!p.length) return '';
  return p.length === 1 ? `第${p[0]}节` : `第${p[0]}-${p[p.length - 1]}节`;
}

/**
 * @param {object} o
 * @param {string} o.file   data/timetable.json
 * @param {object} [o.cfg]
 * @param {object} [o.log]
 * @param {function} [o.now]
 */
function createTimetable({ file, cfg = {}, log = null, now = Date.now } = {}) {
  const opts = { ...TIMETABLE_DEFAULTS, ...cfg };
  const state = {
    semesterStart: opts.semesterStart || null,
    remindBeforeMin: Number(opts.remindBeforeMin) || 10,
    sessions: [],
    sent: {},     // { 'YYYY-MM-DD#idx': true }
    updatedAt: null,
  };

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw.semesterStart) state.semesterStart = raw.semesterStart;
        if (raw.remindBeforeMin) state.remindBeforeMin = Number(raw.remindBeforeMin);
        if (Array.isArray(raw.sessions)) state.sessions = raw.sessions;
        if (raw.sent && typeof raw.sent === 'object') state.sent = raw.sent;
        state.updatedAt = raw.updatedAt || null;
      }
    } catch (e) {
      // 没有文件 = 还没设课表，正常
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      state.updatedAt = new Date(now()).toISOString();
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
      return true;
    } catch (e) {
      log?.warn(`课表保存失败：${e.message}`);
      return false;
    }
  }

  load();

  /** 第几周（不知道开学日期时返回 null） */
  function weekNo(ms = now()) {
    if (!state.semesterStart) return null;
    const s = parseYmd(state.semesterStart);
    if (s === null) return null;
    const n = Math.floor((startOfDayBJ(ms) - s) / (7 * 86400000)) + 1;
    return n > 0 ? n : null;
  }

  function parityOf(ms = now()) {
    const n = weekNo(ms);
    if (!n) return null;
    return n % 2 === 1 ? 'odd' : 'even';
  }

  function setSemesterStart(ymd) {
    const s = parseYmd(ymd);
    if (s === null) return false;
    state.semesterStart = ymd;
    save();
    return true;
  }

  /** 让「本周」= 第 n 周（反推开学的那个周一） */
  function setWeekNo(n, ms = now()) {
    const k = Number(n);
    if (!(k > 0)) return false;
    const monday = startOfDayBJ(ms) - (wdOf(ms) - 1) * 86400000 - (k - 1) * 7 * 86400000;
    state.semesterStart = ymdOf(monday);
    save();
    return true;
  }

  function setRemindBefore(min) {
    const m = Number(min);
    if (!(m >= 0 && m <= 120)) return false;
    state.remindBeforeMin = m;
    save();
    return true;
  }

  /** 这门课在这天要不要上（单双周判断） */
  function activeOn(sec, ms) {
    const p = sec.parity || 'all';
    if (p === 'all') return true;
    const w = parityOf(ms);
    if (!w) return true; // 不知道第几周时按每周算，避免漏课（宁可多提醒）
    return p === w;
  }

  function sessionsOnDay(day) {
    return (state.sessions || [])
      .filter((s) => Number(s.day) === Number(day))
      .sort((a, b) => sessionSpan(a).startMin - sessionSpan(b).startMin);
  }

  function fmtSession(sec) {
    const sp = sessionSpan(sec);
    return `${sp.start}-${sp.end} ${sec.name}${sec.place ? ' · ' + sec.place : ''}${PARITY_CN[sec.parity || 'all'] || ''}`;
  }

  /** 某天（相对今天 ±N 天）的课 */
  function dayView(deltaDays = 0, ms = now()) {
    const t = ms + deltaDays * 86400000;
    const day = wdOf(t);
    const list = sessionsOnDay(day).filter((s) => activeOn(s, t));
    const head = `${ymdOf(t)} ${WEEK_CN[day]}`;
    const w = weekNo(t);
    const tail = w ? ` · 第${w}周` : '';
    if (!list.length) return `${head}${tail}：没课。`;
    return `${head}${tail}：\n` + list.map((s, i) => `${i + 1}. ${fmtSession(s)}`).join('\n');
  }

  /** 整周课表 */
  function weekView(ms = now()) {
    const w = weekNo(ms);
    const parts = [];
    parts.push(`本周课表${w ? `（第${w}周，${w % 2 ? '单' : '双'}周）` : '（单双周未设置）'}`);
    for (let d = 1; d <= 7; d++) {
      const list = sessionsOnDay(d).filter((s) => activeOn(s, ms + (d - wdOf(ms)) * 86400000));
      if (!list.length) continue;
      parts.push(`\n【${WEEK_CN[d]}】`);
      list.forEach((s) => parts.push(`· ${fmtSession(s)}`));
    }
    if (parts.length === 1) parts.push('（课表是空的，还没设过）');
    return parts.join('\n');
  }

  /**
   * 到点该提醒的课：距离上课还有 <= remindBefore 分钟且还没提醒过
   * @returns {Array<{session, minutesLeft, key}>}
   */
  function due(ms = now()) {
    const out = [];
    const day = wdOf(ms);
    const todayStart = startOfDayBJ(ms);
    const list = sessionsOnDay(day);
    for (const sec of list) {
      if (!activeOn(sec, ms)) continue;
      const sp = sessionSpan(sec);
      const startAt = todayStart + sp.startMin * 60000;
      const left = (startAt - ms) / 60000;
      if (left > state.remindBeforeMin || left < -1) continue; // 还没到点 / 已经开课
      const key = `${ymdOf(ms)}#${sec.day}-${(sec.periods || []).join('_')}-${sec.name}`;
      if (state.sent[key]) continue;
      out.push({ session: sec, minutesLeft: Math.max(0, Math.round(left)), key, startAt });
    }
    return out;
  }

  /** 标记已提醒（发出去之后调用） */
  function markSent(keys) {
    let dirty = false;
    for (const k of keys || []) {
      if (!state.sent[k]) { state.sent[k] = true; dirty = true; }
    }
    // 只保留最近 3 天的记录，别让文件涨太大
    const keepFrom = ymdOf(now() - 3 * 86400000);
    for (const k of Object.keys(state.sent)) {
      if (k.split('#')[0] < keepFrom) { delete state.sent[k]; dirty = true; }
    }
    if (dirty) save();
    return dirty;
  }

  /**
   * 定时器调用：返回要发的文案数组（自己决定发不发）
   */
  function tick(ms = now()) {
    if (opts.enabled === false) return [];
    const hour = Math.floor((((ms + BJ) % 86400000) + 86400000) % 86400000 / 3600000);
    if ((opts.quietHours || []).includes(hour)) return [];
    const soon = due(ms);
    if (!soon.length) return [];
    const msgs = soon.map((it) => {
      const sp = sessionSpan(it.session);
      const lead = it.minutesLeft <= 0 ? '现在' : `${it.minutesLeft} 分钟后`;
      return `⏰ ${lead}上课：${it.session.name}${it.session.place ? ' · ' + it.session.place : ''}（${sp.start}-${sp.end}）`;
    });
    markSent(soon.map((it) => it.key));
    return msgs;
  }

  function info() {
    const w = weekNo();
    const n = (state.sessions || []).length;
    return {
      sessions: n,
      weekNo: w,
      parity: w ? (w % 2 ? '单' : '双') : null,
      semesterStart: state.semesterStart,
      remindBeforeMin: state.remindBeforeMin,
    };
  }

  // ---------- 改课表（给「口语改日程」用） ----------

  /** 按名字模糊找课：先精确，再包含 */
  function findByName(name) {
    const q = String(name || '').trim();
    if (!q) return [];
    const all = state.sessions || [];
    const exact = all.filter((s) => String(s.name) === q);
    if (exact.length) return exact;
    const loose = all.filter((s) => String(s.name).includes(q) || q.includes(String(s.name)));
    if (loose.length) return loose;
    // 去掉括号里的内容再试一次（「普通化学(B)」→「普通化学」）
    const core = q.replace(/[（(][^）)]*[）)]/g, '').trim();
    if (core && core !== q) return all.filter((s) => String(s.name).replace(/[（(][^）)]*[）)]/g, '').includes(core) || String(s.name).includes(core));
    return [];
  }

  /**
   * 挪课：把某门课从 from.day 挪到 toDay（periods / place / parity 可一起改）
   * @returns {{ok:boolean, reason?:string, changed?:object}}
   */
  function moveSession({ name, fromDay = null, toDay, periods = null, place = null }) {
    if (!(toDay >= 1 && toDay <= 7)) return { ok: false, reason: '目标星期不对' };
    let cand = findByName(name);
    if (fromDay) cand = cand.filter((s) => Number(s.day) === Number(fromDay));
    if (!cand.length) return { ok: false, reason: `课表里没找到「${name}」${fromDay ? WEEK_CN[fromDay] + '的' : ''}` };
    if (cand.length > 1) return { ok: false, reason: `「${name}」有好几节，得说清是哪天的`, ambiguous: cand.map((s) => `${WEEK_CN[s.day]} ${periodsText(s)}`) };
    const s = cand[0];
    const before = `${WEEK_CN[s.day]} ${periodsText(s)} ${s.name}`;
    s.day = Number(toDay);
    if (Array.isArray(periods) && periods.length) s.periods = periods.map(Number);
    if (place) s.place = String(place);
    save();
    return { ok: true, changed: { before, after: `${WEEK_CN[s.day]} ${periodsText(s)} ${s.name}`, session: s } };
  }

  function removeSession({ name, day = null }) {
    let cand = findByName(name);
    if (day) cand = cand.filter((s) => Number(s.day) === Number(day));
    if (!cand.length) return { ok: false, reason: `课表里没找到「${name}」` };
    if (cand.length > 1) return { ok: false, reason: `「${name}」有好几节，得说清是周几的`, ambiguous: cand.map((s) => `${WEEK_CN[s.day]} ${periodsText(s)}`) };
    const s = cand[0];
    state.sessions = state.sessions.filter((x) => x !== s);
    save();
    return { ok: true, changed: { before: `${WEEK_CN[s.day]} ${periodsText(s)} ${s.name}`, after: '（已删除）' } };
  }

  function addSession({ day, periods, name, place = '', parity = 'all' }) {
    if (!(day >= 1 && day <= 7)) return { ok: false, reason: '星期不对' };
    if (!Array.isArray(periods) || !periods.length) return { ok: false, reason: '没给节次' };
    if (!name) return { ok: false, reason: '没给课名' };
    const sec = { day: Number(day), periods: periods.map(Number), name: String(name), place: String(place || ''), parity: parity === 'odd' || parity === 'even' ? parity : 'all', note: '' };
    state.sessions.push(sec);
    save();
    return { ok: true, changed: { before: '（新增）', after: `${WEEK_CN[sec.day]} ${periodsText(sec)} ${sec.name}${sec.place ? ' · ' + sec.place : ''}` } };
  }

  /** 课表给模型看的紧凑文本（口语改日程时用） */
  function outline() {
    return (state.sessions || [])
      .slice()
      .sort((a, b) => a.day - b.day || sessionSpan(a).startMin - sessionSpan(b).startMin)
      .map((s) => {
        const sp = sessionSpan(s);
        return `${WEEK_CN[s.day]} 第${(s.periods || []).join('-')}节 ${sp.start}-${sp.end} ${s.name}${s.place ? ' @' + s.place : ''}${PARITY_CN[s.parity || 'all'] || ''}`;
      })
      .join('\n');
  }

  /**
   * 某个时刻是不是正好在上课（用于「日程和课表打架」检测）
   * @returns {{session:object,span:object}|null}
   */
  function conflictAt(ms = now()) {
    const day = wdOf(ms);
    const todayStart = startOfDayBJ(ms);
    const min = (ms - todayStart) / 60000;
    for (const sec of sessionsOnDay(day)) {
      if (!activeOn(sec, ms)) continue;
      const sp = sessionSpan(sec);
      if (min >= sp.startMin - 5 && min <= sp.endMin + 5) return { session: sec, span: sp };
    }
    return null;
  }

  /** 今天接下来还有哪些课（相对某时刻） */
  function remainingToday(ms = now()) {
    const day = wdOf(ms);
    const todayStart = startOfDayBJ(ms);
    const min = (ms - todayStart) / 60000;
    return sessionsOnDay(day)
      .filter((s) => activeOn(s, ms))
      .map((s) => ({ session: s, span: sessionSpan(s) }))
      .filter((x) => x.span.startMin > min - 1);
  }

  return {
    state, load, save,
    weekNo, parityOf, setSemesterStart, setWeekNo, setRemindBefore,
    sessionsOnDay, dayView, weekView, due, markSent, tick, info,
    fmtSession, findByName, moveSession, removeSession, addSession, outline,
    conflictAt, remainingToday,
  };
}

module.exports = {
  TIMETABLE_DEFAULTS,
  SECTION_TIMES,
  WEEK_CN,
  createTimetable,
  hhmmToMin,
  minToHhmm,
  dayKeyBJ,
  wdOf,
  ymdOf,
  parseYmd,
};
