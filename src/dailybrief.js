'use strict';
/**
 * 每日简报（2026-10-28 新增）
 *
 * 每天固定时间（默认 8 点）给主人发一条：
 *   今天几节课（几点、在哪）· 今天要提醒你的事 · 最近的考试倒计时
 *
 * 全部来自本地数据，不调模型（省 token，也不会编）。
 */

const DAILYBRIEF_DEFAULTS = {
  enabled: true,
  hour: 8,            // 北京时间几点发
  tickMs: 60000,      // 每分钟看一眼
  examWindowDays: 30, // 只报 30 天内的考试
  maxReminders: 6,
};

const BJ = 8 * 3600 * 1000;

function bjParts(ms) {
  const t = new Date(ms + BJ);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
}

function dayKey(ms) { return Math.floor((ms + BJ) / 86400000); }

/** 北京时间的星期几：1=周一 … 7=周日 */
function wdOf(ms) {
  const r = new Date(ms + BJ).getUTCDay();
  return r === 0 ? 7 : r;
}

function wdText(ms) {
  const p = bjParts(ms);
  return `${p.mo}月${p.d}日 周${'日一二三四五六'[wdOf(ms) % 7]}`;
}

/**
 * 生成简报文本
 * @param {{timetable?:object, reminderStore?:object, examStore?:object, now?:number, cfg?:object, weather?:string}} o
 *   weather: 已经拼好的天气那一句（weather.js 的 render 结果）；没有就不写这一行
 */
function buildBrief({ timetable = null, reminderStore = null, examStore = null, now = Date.now(), cfg = {}, weather = '' } = {}) {
  const conf = { ...DAILYBRIEF_DEFAULTS, ...(cfg || {}) };
  const lines = [];
  lines.push(`早，${wdText(now)}`);
  // 0) 天气（拿不到就不写，别让整条简报缺一块）
  if (weather) lines.push(weather);

  // 1) 今天的课（直接借课表的 dayView，格式统一）
  if (timetable && typeof timetable.dayView === 'function') {
    try {
      const txt = timetable.dayView(0, now) || '';
      const body = txt.split('\n').slice(1).join('\n'); // 去掉「2026-10-28 周三 · 第8周：」这行
      lines.push(body ? `今天：\n${body}` : '今天没课。');
    } catch (e) {
      lines.push('（课表读不出来）');
    }
  }

  // 2) 今天到期的日程
  if (reminderStore && typeof reminderStore.listPending === 'function') {
    try {
      const todayEnd = (dayKey(now) + 1) * 86400000 - BJ;
      const items = reminderStore.listPending().filter((it) => it.at < todayEnd && it.at > now - 3600000);
      if (items.length) {
        lines.push(`\n今天要提醒你的（${items.length} 条）：`);
        items.slice(0, conf.maxReminders).forEach((it) => lines.push(`· ${it.human} ${it.body}`));
        if (items.length > conf.maxReminders) lines.push(`· …还有 ${items.length - conf.maxReminders} 条`);
      }
    } catch (e) { /* 简报不能因为日程炸掉 */ }
  }

  // 3) 考试倒计时
  if (examStore && typeof examStore.listUpcoming === 'function') {
    try {
      const p = examStore.listUpcoming(now).filter((it) => (it.at - now) <= conf.examWindowDays * 86400000);
      if (p.length) {
        lines.push('\n最近的考试：');
        p.slice(0, 3).forEach((it) => {
          const d = examStore.daysLeft(it.at, now);
          lines.push(`· ${it.name} ${it.human || ''}${d >= 0 ? `（还有 ${d} 天）` : ''}`);
        });
      }
    } catch (e) { /* ignore */ }
  }

  return lines.join('\n');
}

/** 今天该发了吗（每天只发一次；到点后 3 小时内可补发，比如手机刚开机） */
function shouldSend(state, now = Date.now(), cfg = {}) {
  const conf = { ...DAILYBRIEF_DEFAULTS, ...(cfg || {}) };
  const p = bjParts(now);
  if (p.h < conf.hour || p.h > conf.hour + 3) return false;
  const key = `${p.y}-${p.mo}-${p.d}`;
  return state.lastKey !== key;
}

module.exports = { DAILYBRIEF_DEFAULTS, buildBrief, shouldSend, wdText, wdOf, bjParts, dayKey };
