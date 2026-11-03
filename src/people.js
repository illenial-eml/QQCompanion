'use strict';
/**
 * 「她对每个人的印象」+ 自己对这些人的态度（2026-10-29 新增）
 *
 * 用户的诉求（m14159）：
 *   1) 让她对每个找她私聊的人产生「印象」，记录最近聊了什么（主人可以问）
 *   2) 产生一些她自己的「态度」
 *
 * 设计：
 *   - 每人一条记录：见面次数、最近说了几句、印象摘要（模型偶尔提炼一次）、
 *     以及**她自己的态度**（三档：喜欢 / 一般 / 一般但有点烦，外加一句自己的评价）
 *   - 态度不靠模型现编：按「聊得多不多、好不好玩、有没有越界」压成 0–3 分，落盘后读回来。
 *     这样重启之后她对某个人的态度是稳定的（不会今天熟明天陌生）。
 *   - 记忆里的「私聊对象」摘要由她自己在聊天时写一句（见 brain.js 的 peopleNote），
 *     这里只负责存 + 压缩 + 给主人看。
 *
 * 全部纯本地，不联网、不额外调模型。
 */

const fs = require('fs');
const path = require('path');

const PEOPLE_DEFAULTS = {
  enabled: true,
  maxPeople: 300,        // 最多记多少人
  maxRecent: 3,          // 每人记最近几句原话
  pruneDays: 90,         // 90 天没说过话的，印象压成一句话留着
  summarizeEvery: 8,     // 每聊 8 句让模型更新一次印象
};

function nowMs() { return Date.now(); }

function bjText(ms) {
  const t = new Date(ms + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

function agoText(ms, now = nowMs()) {
  const d = Math.max(0, now - ms);
  const m = Math.floor(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return `${Math.floor(day / 30)} 个月前`;
}

/** 态度分 0–3 → 一句人话 + 她对这人的说话调子 */
const ATTITUDE = [
  { min: 0, label: '还没什么感觉', tone: '客气一点，别装熟' },
  { min: 1, label: '还行，正常聊', tone: '正常聊，别太热络' },
  { min: 2, label: '挺聊得来', tone: '可以放松一点、带点玩笑' },
  { min: 3, label: '挺喜欢这个人', tone: '可以主动一点、记得他的事、偶尔怼两句' },
];

function attitudeFor(score) {
  let pick = ATTITUDE[0];
  for (const a of ATTITUDE) if (score >= a.min) pick = a;
  return pick;
}

/**
 * 算态度分：只吃本地信号，不同人之间可比
 *   聊得多（turns）→ 熟
 *   有好玩的（funHits）→ 加分
 *   越界过（rudeHits）→ 扣分（但不会变成负数，毕竟还愿意聊）
 */
function scoreOf(p) {
  const turns = Number(p.turns) || 0;
  const fun = Number(p.funHits) || 0;
  const rude = Number(p.rudeHits) || 0;
  let s = 0;
  if (turns >= 3) s += 1;
  if (turns >= 12) s += 1;
  if (turns >= 40) s += 1;
  if (fun >= 2) s += 1;
  if (fun >= 6) s += 1;
  s -= rude >= 2 ? 2 : rude >= 1 ? 1 : 0;
  return Math.max(0, Math.min(3, s));
}

function createPeopleStore({ file, cfg = {}, log = null, now = nowMs } = {}) {
  const conf = { ...PEOPLE_DEFAULTS, ...(cfg || {}) };
  let state = { version: 1, people: {} };

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data.people === 'object') state = data;
    } catch (e) {
      if (e.code !== 'ENOENT') log?.warn?.('印象库读取失败，先当空的重来:', e.message);
    }
    return state;
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (e) {
      log?.warn?.('印象库保存失败:', e.message);
    }
  }
  load();

  function get(userId) {
    return state.people[String(userId)] || null;
  }

  /** 第一次见面时建一条 */
  function ensure(userId, name = '') {
    const id = String(userId || '');
    if (!id) return null;
    let p = state.people[id];
    if (!p) {
      p = {
        id,
        name: name || '',
        aliases: [],      // 同一个人别的叫法（备注 / 群名片 / 昵称），查印象时都能对上
        firstSeen: now(),
        lastSeen: now(),
        turns: 0,
        funHits: 0,
        rudeHits: 0,
        recent: [],       // 最近聊的几句（短）
        note: '',         // 她自己的印象摘要（模型偶尔更新）
        attitude: 0,      // 落盘的态度分
        summarizedTurns: 0,
      };
      state.people[id] = p;
    }
    if (name) p.name = name;
    return p;
  }

  /**
   * 记下这个人所有的叫法（备注/群名片/昵称）。
   * 主人问的是备注名，OneBot 事件里只有昵称/群名片，两边对不上就答不出来——这里补齐。
   */
  function setAliases(userId, list = []) {
    const p = get(userId);
    if (!p) return false;
    const set = new Set((p.aliases || []).map((x) => String(x)));
    for (const s of list || []) {
      const v = String(s || '').trim();
      if (v && v.length <= 24) set.add(v);
    }
    p.aliases = [...set].slice(-8);
    save();
    return true;
  }

  /** 按名字（备注/别名/QQ 号）找一个人；找不到返回 null，不瞎猜 */
  function find(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const byId = state.people[q];
    if (byId) return byId;
    const list = Object.values(state.people);
    const names = (p) => [p.name, ...(p.aliases || [])].map((s) => String(s || '').trim()).filter(Boolean);
    const exact = list.find((p) => names(p).includes(q));
    if (exact) return exact;
    const pref = list.find((p) => names(p).some((n) => n.startsWith(q)));
    if (pref) return pref;
    const part = q.length >= 2 ? list.find((p) => names(p).some((n) => n.includes(q))) : null;
    return part || null;
  }

  /**
   * 记一句话。kind: 'normal' | 'fun' | 'rude'
   * 返回这一句要不要让模型重算印象（每 summarizeEvery 句一次）
   */
  function observe({ userId, name = '', text = '', kind = 'normal' } = {}) {
    if (conf.enabled === false) return { needed: false };
    const p = ensure(userId, name);
    if (!p) return { needed: false };
    p.lastSeen = now();
    p.turns += 1;
    if (kind === 'fun') p.funHits += 1;
    if (kind === 'rude') p.rudeHits += 1;
    const t = String(text || '').trim();
    if (t) {
      p.recent.push({ text: t.slice(0, 60), at: now() });
      if (p.recent.length > conf.maxRecent) p.recent = p.recent.slice(-conf.maxRecent);
    }
    p.attitude = scoreOf(p);
    trimPeople();
    save();
    const needed = p.turns - (p.summarizedTurns || 0) >= conf.summarizeEvery;
    return { needed, person: p };
  }

  /** 模型提炼好的一句印象，写回来 */
  function setNote(userId, note) {
    const p = get(userId);
    if (!p) return false;
    const s = String(note || '').trim().slice(0, 80);
    if (!s) return false;
    p.note = s;
    p.summarizedTurns = p.turns;
    p.attitude = scoreOf(p);
    save();
    return true;
  }

  /** 超出上限时，把最久没聊、话最少的挪出去 */
  function trimPeople() {
    const list = Object.values(state.people);
    if (list.length <= conf.maxPeople) return;
    list.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
    const drop = list.slice(0, list.length - conf.maxPeople);
    for (const p of drop) delete state.people[p.id];
  }

  /** 给她聊天时用的上下文：这个人她是熟是生、上次聊了啥 */
  function contextFor(userId) {
    if (conf.enabled === false) return '';
    const p = get(userId);
    if (!p) return '';
    const a = attitudeFor(p.attitude);
    const lines = [];
    lines.push(`## 你對这个人（${p.name || '对方'}）的印象`);
    if (p.turns <= 1) {
      lines.push('· 你们刚认识，你对他没什么印象。');
    } else {
      lines.push(`· 你们聊过 ${p.turns} 句，上次是 ${agoText(p.lastSeen, now())}。`);
      // 印象是模型自己总结的，可能想错；标明「只是背景」，别让它反过来支配语气
      if (p.note) lines.push(`· 你之前随手记的一句印象（只是背景，可能不准，别拿它当判断依据）：${p.note}`);
      if (p.recent && p.recent.length) {
        const last = p.recent[p.recent.length - 1];
        lines.push(`· 上一次他说的：${last.text}`);
      }
      lines.push(`· 你现在的态度：${a.label}（${a.tone}）。`);
      if (p.rudeHits > 0) lines.push('· 他之前说过难听的话，不用对他太客气，但也别主动找茬。');
    }
    return lines.join('\n');
  }

  /** 主人问起「别人」时用的名册：只给名字 + 一句印象，别把整库塞进去 */
  function rosterFor({ excludeId = '', limit = 8 } = {}) {
    if (conf.enabled === false) return '';
    const list = Object.values(state.people)
      .filter((p) => String(p.id) !== String(excludeId || ''))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .slice(0, limit);
    if (!list.length) return '';
    const lines = ['## 你认识的其他人（名字都是你主人给他们设的备注，别和眼前这个人搞混）'];
    for (const p of list) {
      const a = attitudeFor(p.attitude);
      const note = p.note ? `：${p.note}` : '';
      lines.push(`· ${p.name || p.id}（聊过 ${p.turns || 0} 句，态度${a.label}）${note}`);
    }
    return lines.join('\n');
  }

  /** 给主人看的：她都在聊什么 */
  function view({ userId = '', limit = 20 } = {}) {
    const list = Object.values(state.people).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    if (userId) {
      const p = get(userId);
      if (!p) return '我还不认识这个人。';
      const a = attitudeFor(p.attitude);
      const out = [
        `【${p.name || p.id}】`,
        `· 聊过 ${p.turns} 句，第一次 ${agoText(p.firstSeen)}，最后一次 ${agoText(p.lastSeen)}`,
        `· 我对他的印象：${p.note || '（还说不清）'}`,
        `· 我的态度：${a.label}`,
      ];
      if (p.recent && p.recent.length) {
        out.push('· 最近说过的话：');
        for (const r of p.recent) out.push(`   - ${r.text}`);
      }
      return out.join('\n');
    }
    if (!list.length) return '我还没跟谁单独聊过。';
    const out = [`我一共认识 ${list.length} 个人（按最近聊的排）：`];
    for (const p of list.slice(0, limit)) {
      const a = attitudeFor(p.attitude);
      out.push(`· ${p.name || p.id}（${p.turns} 句 · ${a.label}）${p.note ? '：' + p.note : ''}`);
    }
    if (list.length > limit) out.push(`…还有 ${list.length - limit} 个`);
    return out.join('\n');
  }

  return {
    load, save, get, ensure, observe, setNote, setAliases, find, contextFor, rosterFor, view,
    settings: conf,
    state: () => state,
  };
}

module.exports = { PEOPLE_DEFAULTS, createPeopleStore, attitudeFor, scoreOf, agoText, bjText };
