'use strict';
/**
 * 每个聊天对象一份记忆，落盘成 data/memory/<id>.json
 * 结构: { id, name, notes: string[], turns: [{role, content, at}], updatedAt }
 * turns 只保留最近 maxTurns 条，超出的丢弃（旧的靠 notes 记）。
 */
const fs = require('fs');
const path = require('path');

const NAME_MAP = {
  user: 'user',
  assistant: 'assistant',
};

class MemoryStore {
  constructor({ dir, maxTurns = 24, maxChars = 12000, log }) {
    this.dir = dir;
    this.maxTurns = maxTurns;
    this.maxChars = maxChars;
    this.log = log;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  _file(id) {
    const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    let data = { id, name: null, notes: [], turns: [], updatedAt: null };
    const f = this._file(id);
    if (fs.existsSync(f)) {
      try {
        data = { ...data, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
      } catch (e) {
        this.log?.warn('记忆文件损坏，忽略:', f, e.message);
      }
    }
    this.cache.set(id, data);
    return data;
  }

  addTurn(id, role, content) {
    const m = this.get(id);
    m.turns.push({ role: NAME_MAP[role] || role, content: String(content), at: Date.now() });
    // 条数截断
    if (m.turns.length > this.maxTurns) m.turns = m.turns.slice(-this.maxTurns);
    // 字符数截断（防止一次超长消息把上下文撑爆）
    let total = m.turns.reduce((n, t) => n + t.content.length, 0);
    while (total > this.maxChars && m.turns.length > 2) {
      total -= m.turns.shift().content.length;
    }
    m.updatedAt = Date.now();
    this.save(id);
  }

  setNote(id, note) {
    const m = this.get(id);
    let text = String(note).trim();
    if (!text) return;
    // 给笔记打上日期：否则「明天要上班」这种话会被当成永远有效的事实
    if (!/^\[\d{1,2}月\d{1,2}日\]/.test(text)) {
      const d = new Date(Date.now() + 8 * 3600000);
      text = `[${d.getUTCMonth() + 1}月${d.getUTCDate()}日] ${text}`;
    }
    if (!m.notes.includes(text)) m.notes.push(text);
    if (m.notes.length > 40) m.notes = m.notes.slice(-40);
    this.pruneNotes(m);
    this.save(id);
  }

  /**
   * 丢掉过期笔记：带日期的笔记超过 maxAgeDays 天就删（默认 3 天）。
   * 只处理「[M月D日] …」这种新格式，老的无日期笔记保留。
   */
  pruneNotes(m, maxAgeDays = 3) {
    if (!Array.isArray(m.notes) || !m.notes.length) return 0;
    const bj = new Date(Date.now() + 8 * 3600000);
    const today = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
    const before = m.notes.length;
    // 只有「带相对时间词」的笔记才是会过期的计划（明天要上班 / 今晚有课），
    // 名字、爱好、他的性格这种长期事实即使带日期也永远保留。
    const VOLATILE = /明天|今天|今晚|明早|后天|大后天|下周|这周|本周|周末|待会|一会儿|等一下/;
    m.notes = m.notes.filter((n) => {
      const s = String(n);
      if (!VOLATILE.test(s)) return true;
      const hit = /^\[(\d{1,2})月(\d{1,2})日\]/.exec(s);
      if (!hit) return true;
      const d = Date.UTC(bj.getUTCFullYear(), Number(hit[1]) - 1, Number(hit[2]));
      const age = (today - d) / 86400000;
      return age <= maxAgeDays && age >= -1;
    });
    return before - m.notes.length;
  }

  setName(id, name) {
    const m = this.get(id);
    if (name && m.name !== name) { m.name = name; this.save(id); }
  }

  lastActive(id) {
    return this.get(id).updatedAt || 0;
  }

  /**
   * 把所有聊天对象里某一角色的发言按时间顺序抽出来。
   * 用途：语气样本库第一次启动时，用已有的聊天记忆把样本补上。
   */
  allTurns(role = 'user') {
    const out = [];
    if (!fs.existsSync(this.dir)) return out;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const f = path.join(this.dir, name);
      try {
        const data = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
        for (const t of data?.turns || []) {
          if (t && t.role === role && t.content) out.push({ id: data.id || name, content: String(t.content), at: Number(t.at) || 0 });
        }
      } catch (e) {
        this.log?.debug?.('跳过读取失败的记忆文件', f, e.message);
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  save(id) {
    const m = this.get(id);
    const f = this._file(id);
    const tmp = f + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
      fs.renameSync(tmp, f);
    } catch (e) {
      this.log?.error('写记忆失败', f, e.message);
    }
  }
}

module.exports = { MemoryStore };
