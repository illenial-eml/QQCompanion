'use strict';
/**
 * 群聊日志：把每个群最近说过的话单独存一份。
 *
 * 为什么要单独存：
 *   机器人对每个群有一份自己的记忆（`g:<群openid>.json`），私聊又有一份。
 *   你在私聊里问「群里刚才聊啥了」，它的私聊记忆里根本没有群里的内容，
 *   所以这里把群里的发言额外记一份，私聊时当成「你不在场时的其他场景」塞进提示词。
 *
 * 只存文字（表情/图片/语音会被过滤），单个群最多 maxLines 条，总字数有上限。
 *
 * 隐私边界要讲清楚（别记混）：
 *   - 群里的发言**不进**「聊天记忆」（memory 里只记被 @ / 指名说到的那些）
 *   - 但会**进**这里的群日志（每条截 maxChars 字，最多 maxLines 条，只在本地 data/groups/ 下）
 *   - injectInPrivate 默认 false：默认不把群聊内容塞进私聊提示词；要用就显式打开
 */

const fs = require('node:fs');
const path = require('node:path');

const GROUP_LOG_DEFAULTS = {
  enabled: true,
  dir: '',              // 默认 data/groups
  maxLines: 200,        // 每个群最多留多少条
  maxChars: 120,        // 单条最多存多少字
  saveDelayMs: 2000,    // 攒一下再写盘（群里消息密，别每条都写文件）
  injectInPrivate: false, // 默认不把群聊内容带进私聊提示词（要带就显式设 true）
  hours: 8,             // 私聊里带最近多少小时内的群聊
  perGroup: 6,          // 每个群带几条
  maxGroups: 4,         // 最多带几个群
};

/** 群 openid 里可能有 - 和字母数字，别的字符一律换掉，免得当文件名出问题 */
function safeName(groupId) {
  return String(groupId || '').replace(/[^\w.-]/g, '_').slice(0, 80) || 'unknown';
}

/** 值得记的才算（纯表情/纯图片占位/一个字的气声没参考价值） */
function isWorthRecording(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^(\[(表情|图片|语音|文件|视频)\]\s*)+$/.test(t)) return false;
  if (/^[嗯啊哦噢哈嘿呵额诶唉好行]{1,2}$/.test(t)) return false;
  return t.length >= 2;
}

function createGroupLog({ dir, cfg = {}, log, now = Date.now, timer = { set: setTimeout, clear: clearTimeout } } = {}) {
  const opt = { ...GROUP_LOG_DEFAULTS, ...(cfg || {}) };
  if (!dir) throw new Error('createGroupLog 需要 dir');

  const store = new Map();     // groupId -> { groupId, label, updatedAt, lines: [{ who, text, at }] }
  const seen = new Set();      // 已经尝试从磁盘读过的
  let dirty = new Set();
  let timerId = null;

  function fileOf(groupId) {
    return path.join(dir, safeName(groupId) + '.json');
  }

  function load(groupId) {
    if (seen.has(groupId)) return store.get(groupId) || null;
    seen.add(groupId);
    try {
      const raw = fs.readFileSync(fileOf(groupId), 'utf8');
      const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (data && Array.isArray(data.lines)) {
        store.set(groupId, {
          groupId,
          label: data.label || '',
          updatedAt: data.updatedAt || 0,
          lines: data.lines.slice(-opt.maxLines),
        });
      }
    } catch {
      /* 文件不存在 / 坏了都当空，别让日志问题拖垮机器人 */
    }
    return store.get(groupId) || null;
  }

  function nextLabel() {
    loadAll(); // 先把磁盘上已有的群都读进来，否则新群又会从「群1」开始（会撞号）
    let max = 0;
    for (const st of store.values()) {
      const m = /^群(\d+)$/.exec(st.label || '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `群${max + 1}`;
  }

  function ensure(groupId) {
    let st = load(groupId);
    if (!st) {
      st = { groupId, label: nextLabel(), updatedAt: 0, lines: [] };
      store.set(groupId, st);
    }
    if (!st.label) st.label = nextLabel();
    return st;
  }

  function saveNow() {
    const ids = [...dirty];
    dirty = new Set();
    for (const groupId of ids) {
      const st = store.get(groupId);
      if (!st) continue;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = fileOf(groupId) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
        fs.renameSync(tmp, fileOf(groupId));
      } catch (e) {
        log?.warn?.('群聊日志写盘失败:', e.message);
      }
    }
  }

  function schedule() {
    if (timerId) return;
    timerId = timer.set(() => { timerId = null; saveNow(); }, opt.saveDelayMs);
    timerId?.unref?.();
  }

  /** 记一条群消息（不认识的消息直接忽略） */
  function record({ groupId, who, text, at = now() } = {}) {
    if (!opt.enabled || !groupId) return false;
    if (!isWorthRecording(text)) return false;
    const st = ensure(groupId);
    const line = {
      who: String(who || '有人').slice(0, 24),
      text: String(text).trim().slice(0, opt.maxChars),
      at,
    };
    st.lines.push(line);
    if (st.lines.length > opt.maxLines) st.lines = st.lines.slice(-opt.maxLines);
    st.updatedAt = at;
    dirty.add(groupId);
    schedule();
    return true;
  }

  /** 最近有动静的群（按最后发言时间倒序） */
  function recentGroups({ hours = opt.hours, maxGroups = opt.maxGroups, perGroup = opt.perGroup } = {}) {
    const since = now() - Math.max(1, hours) * 3600 * 1000;
    const out = [];
    for (const st of store.values()) {
      const lines = st.lines.filter((l) => l.at >= since);
      if (!lines.length) continue;
      out.push({ groupId: st.groupId, label: st.label || '某个群', updatedAt: st.updatedAt, lines: lines.slice(-perGroup) });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, Math.max(1, maxGroups));
  }

  /**
   * 拼成提示词里的一段。
   * botName 是它自己在群里的名字（它自己说的写成「我」）；
   * selfNames 是「他」在群里的昵称，命中就写成「你」，免得模型把本人当成别人。
   */
  function digest({ botName = '', selfNames = [], hours, perGroup, maxGroups, maxCharsPerLine = 60, nameOf = null } = {}) {
    const list = recentGroups({ hours, perGroup, maxGroups });
    if (!list.length) return '';
    const mine = new Set((selfNames || []).filter(Boolean));
    const lines = ['## 群里最近在聊什么'];
    lines.push('（下面是你不在的那些群里最近说过的话。他问起来就照实说；他不问就别主动念清单。括号里的群名就用他真的群名，没有名字才用编号。）');
    for (const g of list) {
      const body = g.lines
        .map((l) => {
          let who = l.who;
          if ((botName && l.who === botName) || l.who === '我') who = '我';
          else if (mine.has(l.who)) who = '你';
          const t = l.text.length > maxCharsPerLine ? l.text.slice(0, maxCharsPerLine) + '…' : l.text;
          return `${who}：${t}`;
        })
        .join(' ｜ ');
      lines.push(`- ${(nameOf && nameOf(g.groupId)) || g.label}（最近 ${g.lines.length} 条）：${body}`);
    }
    return lines.join('\n');
  }

  function groups() {
    return [...store.values()].map((st) => ({ groupId: st.groupId, label: st.label, updatedAt: st.updatedAt, count: st.lines.length }));
  }

  /** 这个群在自己目录里的编号（群1/群2…），没记录过也能算出来 */
  function labelOf(groupId) {
    if (!groupId) return '';
    const st = load(groupId);
    return st?.label || '';
  }

  /** 把磁盘上所有群日志都读进来（用于「按编号找群」「给新群分配不重复的编号」） */
  function loadAll() {
    if (!dir) return groups();
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return groups(); }
    for (const f of files) load(f.replace(/\.json$/, ''));
    normalizeLabels();
    return groups();
  }

  /**
   * 编号去重：早先的版本里，不同群各自从「群1」开始编号，会出现两个群都叫「群1」。
   * 这里按最后活跃时间排一下，重复的重新编号，并标记待写盘。
   */
  function normalizeLabels() {
    let max = 0;
    for (const st of store.values()) {
      const m = /^群(\d+)$/.exec(st.label || '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    const used = new Set();
    const sorted = [...store.values()].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    for (const st of sorted) {
      if (!st.label || used.has(st.label)) {
        st.label = `群${++max}`;
        dirty.add(st.groupId);
      }
      used.add(st.label);
    }
  }

  /** 按编号（群1）或 openid 找群 openid */
  function findGroup(key) {
    const k = String(key || '').trim();
    if (!k) return '';
    loadAll();
    for (const st of store.values()) {
      if (st.groupId === k) return st.groupId;
      if (st.label === k) return st.groupId;
    }
    return '';
  }

  function flush() {
    if (timerId) { timer.clear(timerId); timerId = null; }
    saveNow();
  }

  return { record, recentGroups, digest, groups, labelOf, loadAll, findGroup, flush, settings: opt };
}

module.exports = { createGroupLog, GROUP_LOG_DEFAULTS, safeName, isWorthRecording };
