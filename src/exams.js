'use strict';
/**
 * 考试登记 + 倒计时（2026-10-28 新增）
 *
 * 主人说「考试 12月28日 晚上 高等数学」，记下来；「考试倒计时」列出按日期排的清单，
 * 每天早上的简报里也会带最近的几场。
 *
 * 数据文件 data/exams.json：
 *   { items: [ { id, name, at, hasTime, place } ] }
 *
 * 只认主人私聊（调用方保证），不经过模型。
 */

const fs = require('fs');
const path = require('path');

const EXAM_DEFAULTS = { enabled: true, maxItems: 40 };

const CN_DIGITS = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const NUM = '(\\d{1,2}|[一二两三四五六七八九十]{1,3})';
const BJ = 8 * 3600 * 1000;

function pad2(n) { return String(n).padStart(2, '0'); }

function toNumber(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^([零一二两三四五六七八九])?十([零一二三四五六七八九])?$/);
  if (m) {
    const tens = m[1] === undefined ? 1 : CN_DIGITS[m[1]];
    const ones = m[2] === undefined ? 0 : CN_DIGITS[m[2]];
    if (tens === undefined || ones === undefined) return null;
    return tens * 10 + ones;
  }
  if (s.length === 1 && CN_DIGITS[s] !== undefined) return CN_DIGITS[s];
  return null;
}

function bjParts(ms) {
  const t = new Date(ms + BJ);
  return {
    y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(),
    h: t.getUTCHours(), mi: t.getUTCMinutes(),
  };
}

function bjToMs(y, mo, d, h, mi) { return Date.UTC(y, mo - 1, d, h - 8, mi, 0, 0); }

function fmt(ms, hasTime = true) {
  const p = bjParts(ms);
  return hasTime
    ? `${p.mo}月${p.d}日 ${pad2(p.h)}:${pad2(p.mi)}`
    : `${p.mo}月${p.d}日`;
}

/** 还有几天（按北京日界，向上取整到「天」） */
function daysLeft(at, now = Date.now()) {
  const a = Math.floor((at + BJ) / 86400000);
  const b = Math.floor((now + BJ) / 86400000);
  return a - b;
}

/**
 * 解析一句「登记考试」
 *   考试 12月28日 晚上 高等数学
 *   记一下 12月29号下午 2点 普通化学考试
 * @returns {{name:string, at:number, hasTime:boolean, human:string}|null}
 */
function parseExam(text, now = Date.now()) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (!/(考试|期末|期中考|大考|测验)/.test(raw)) return null;

  const mp = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  let mo = mp ? Number(mp[1]) : null;
  let dd = mp ? Number(mp[2]) : null;
  if (mo === null) {
    const m2 = raw.match(/(?<![\d:])(\d{1,2})\s*[/-]\s*(\d{1,2})(?![\d:])/);
    if (m2) { mo = Number(m2[1]); dd = Number(m2[2]); }
  }
  if (mo === null || !(mo >= 1 && mo <= 12) || !(dd >= 1 && dd <= 31)) return null;

  // 时间
  let hour = null;
  let minute = 0;
  const tm = raw.match(new RegExp(`${NUM}\\s*[点時时]\\s*(半|${NUM}分?)?`));
  if (tm) {
    hour = toNumber(tm[1]);
    if (tm[2] === '半') minute = 30;
    else if (tm[2]) { const mm = toNumber(String(tm[2]).replace('分', '')); if (mm !== null) minute = mm; }
    const cm = raw.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
    if (cm) { hour = Number(cm[1]); minute = Number(cm[2]); }
    if (hour !== null && hour < 12) {
      if (/(下午|傍晚|晚上|晚间|夜里|夜)/.test(raw)) hour += 12;
      else if (/(中午|正午)/.test(raw)) { if (hour < 9) hour += 12; }
    }
    if (hour !== null && hour >= 24) hour -= 24;
  } else if (/(晚上|晚间|夜里|夜)/.test(raw)) hour = 19;
  else if (/(下午|午后)/.test(raw)) hour = 14;
  else if (/(早上|上午|早晨)/.test(raw)) hour = 8;

  const p = bjParts(now);
  let at = hour === null ? bjToMs(p.y, mo, dd, 9, 0) : bjToMs(p.y, mo, dd, hour, minute);
  if (at < now - 86400000) at = bjToMs(p.y + 1, mo, dd, hour === null ? 9 : hour, minute);

  // 名字：去掉日期/时间/命令词
  let name = raw
    .replace(/(考试|期末|期中考|大考|测验)/g, ' ')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, ' ')
    .replace(/(?<![\d:])\d{1,2}\s*[/-]\s*\d{1,2}(?![\d:])/g, ' ')
    .replace(new RegExp(`${NUM}\\s*[点時时]\\s*(?:半|${NUM}分?)?`), ' ')
    .replace(/\d{1,2}[:：]\d{1,2}/g, ' ')
    .replace(/(?:今天|明天|后天|大后天|下周|这周)/g, ' ')
    .replace(/(?:早上|上午|中午|下午|晚上|晚间|夜里|凌晨|傍晚)/g, ' ')
    .replace(/^(?:考试|记一下|记下|登记|加一个|安排|提醒我?|帮我)+/g, ' ')
    .replace(/[，,。.!！?？~～、:：]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) name = '考试';
  if (name.length > 30) name = name.slice(0, 30) + '…';

  return { name, at, hasTime: hour !== null, human: fmt(at, hour !== null) };
}

function createExamStore({ file, cfg = {}, log = null, now = Date.now } = {}) {
  const conf = { ...EXAM_DEFAULTS, ...(cfg || {}) };
  let state = { items: [] };
  try {
    if (file && fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && Array.isArray(raw.items)) state = raw;
    }
  } catch (e) {
    log?.warn?.('读考试列表失败，当成空的:', e.message);
  }
  if (!Array.isArray(state.items)) state.items = [];

  let seq = state.items.reduce((mx, it) => Math.max(mx, Number(it.id) || 0), 0);

  function save() {
    try {
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 1));
    } catch (e) {
      log?.warn?.('存考试列表失败:', e.message);
    }
  }

  function add({ name, at, hasTime = false }) {
    if (state.items.length >= conf.maxItems) return { ok: false, reason: 'too-many' };
    const dup = state.items.find((x) => x.name === name && Math.abs(x.at - at) < 3600000);
    if (dup) return { ok: false, reason: 'dup', item: dup };
    const item = { id: ++seq, name, at, hasTime, createdAt: now() };
    state.items.push(item);
    save();
    return { ok: true, item };
  }

  function listUpcoming(t = now()) {
    return state.items.filter((it) => it.at > t - 86400000).sort((a, b) => a.at - b.at);
  }

  function removeByIndex(n) {
    const p = listUpcoming();
    const it = p[Number(n) - 1];
    if (!it) return null;
    state.items = state.items.filter((x) => x.id !== it.id);
    save();
    return it;
  }

  /** 倒计时文案 */
  function view(t = now()) {
    const p = listUpcoming(t);
    if (!p.length) return '还没登记考试。\n说法：「考试 12月28日晚上 高等数学」';
    return `考试倒计时（${p.length} 场）：\n` + p.map((it, i) => {
      const d = daysLeft(it.at, t);
      const when = d > 0 ? `还有 ${d} 天` : d === 0 ? '就是今天' : '已过';
      return `${i + 1}. ${it.name} · ${fmt(it.at, it.hasTime)}（${when}）`;
    }).join('\n');
  }

  return { cfg: conf, state, add, listUpcoming, removeByIndex, view, save, daysLeft };
}

module.exports = {
  EXAM_DEFAULTS, createExamStore, parseExam, fmt, daysLeft, toNumber,
};
