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

/**
 * 定长环形缓冲（用于最近 N 轮对话）
 *
 * 之前用 `arr.push(...)` + `arr.slice(-N)` / `arr.shift()`：
 * 每次越界都要整块移动元素，单条 O(n)，条数一多就不再是常数开销。
 * 改成固定容量数组 + 头指针 + 长度：
 *   - 入队：写到 (head + len) % cap，满了就把 head 前移一格覆盖最旧的
 *   - 出队：head 前移，len--
 * 两件事都是 O(1)，不需要搬数据。
 */
class RingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0);
    this.buf = new Array(this.capacity);
    this.head = 0;   // 最旧元素所在下标
    this.len = 0;
  }

  get size() { return this.len; }
  get full() { return this.len === this.capacity; }

  /** 下标 0 是最旧、len-1 是最新 */
  at(i) {
    if (i < 0 || i >= this.len) return undefined;
    return this.buf[(this.head + i) % this.capacity];
  }

  push(x) {
    if (this.len < this.capacity) {
      this.buf[(this.head + this.len) % this.capacity] = x;
      this.len += 1;
      return null;            // 没被挤掉的
    }
    const evicted = this.buf[this.head];   // 覆盖最旧的
    this.buf[this.head] = x;
    this.head = (this.head + 1) % this.capacity;
    return evicted;
  }

  shift() {
    if (!this.len) return undefined;
    const x = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.len -= 1;
    return x;
  }

  /** 从头到尾展开成普通数组（只在需要交给模型时调用） */
  toArray() {
    const out = new Array(this.len);
    for (let i = 0; i < this.len; i += 1) out[i] = this.buf[(this.head + i) % this.capacity];
    return out;
  }

  static from(arr, capacity) {
    const rb = new RingBuffer(capacity);
    for (const x of arr) rb.push(x);
    return rb;
  }
}

/** 每个 id 一份：ring 是真身，m.turns 保持与它同步（兼容老代码直接读 turns） */
const RINGS = new WeakMap();

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
    RINGS.set(data, RingBuffer.from(data.turns || [], this.maxTurns));
    return data;
  }

  addTurn(id, role, content) {
    const m = this.get(id);
    const ring = RINGS.get(m);
    ring.push({ role: NAME_MAP[role] || role, content: String(content), at: Date.now() });
    // 字符数截断（防止一次超长消息把上下文撑爆）；环形缓冲保证条数上限 O(1)
    let total = 0;
    for (let i = 0; i < ring.size; i += 1) total += ring.at(i).content.length;
    while (total > this.maxChars && ring.size > 2) {
      total -= ring.shift().content.length;
    }
    m.turns = ring.toArray();
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
    // 真身是环形缓冲，落盘前展开成普通数组（保证 JSON 里就是时间顺序）
    const ring = RINGS.get(m);
    const data = ring ? { ...m, turns: ring.toArray() } : m;
    const f = this._file(id);
    const tmp = f + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, f);
    } catch (e) {
      this.log?.error('写记忆失败', f, e.message);
    }
  }
}

module.exports = { MemoryStore, RingBuffer };
