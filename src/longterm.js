'use strict';
/**
 * 长期记忆（longterm）—— 「记忆选择机制」
 *
 * 背景：memory.js 里的 turns 是**短期记忆**，只保留最近 24 条 / 12000 字，
 * 聊久了就被挤掉了。但有些事不该忘：
 *
 *   1. 主人明确要求记住的（「记住：…」「别忘了…」）        → importance 5，永不自动清
 *   2. 主人自己说过的、关于他自己的事实（专业/习惯/喜好/雷点）→ importance 4
 *   3. 约定和承诺（「明天要…」「以后每周…」「说好了…」）    → importance 4
 *   4. 从对话里顺手捞到的杂事（今天在干嘛、临时的事）        → importance 2，会淡出
 *
 * 选择机制（什么时候进长期、什么时候丢）：
 *   - 进：主人一句话里出现「记住/别忘/记着」→ 直接进（最高优先级）
 *   - 进：自动提炼，但**每天最多 autoPerDay 条**，避免把闲聊垃圾塞满
 *   - 留：条数上限 maxItems；importance 高的先淘汰低的
 *   - 丢：importance <= 2 且 decayDays 天没被引用过 → 淡出（等于「上下文失效后清除」）
 *
 * 存储：data/longterm.json（人可读、可直接删）
 * 结构：{ version, items: [{id, subject, text, kind, importance, source, at, usedAt, hits}] }
 */

const fs = require('fs');
const path = require('path');

const LONGTERM_DEFAULTS = {
  enabled: true,
  maxItems: 400,
  maxPinned: 12, // 每次塞进提示词的「高优先级」上限
  recallLimit: 6, // 每次按相关性召回的上限
  minScore: 0.22, // 相关性阈值（太低会塞进无关记忆）
  autoPerDay: 2, // 自动提炼每天最多几条
  decayDays: 45, // importance<=2 且这么久没用过 → 淡出
  maxChars: 120, // 单条记忆最长（字）
};

const KINDS = ['fact', 'preference', 'promise', 'event', 'rule'];

/* ───────────────────────── 解析：主人下命令 ───────────────────────── */

/**
 * 「记住：xxx」「别忘了 xxx」「记着 xxx」「记下来 xxx」
 * @returns {{action:'remember', body:string}|null}
 */
function parseRemember(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const m = t.match(
    /^(?:请)?(?:你)?(?:要|给我|帮我)?(?:记住|记好|记牢|记着|记一下|记下来|记下|存一下|别忘了|别忘记)[：:，,、\s]*(.{2,300})$/s
  );
  if (!m) return null;
  // 前置的冒号/引号可能被上面的「分隔符」漏掉，这里再剥一层
  const body = m[1]
    .trim()
    .replace(/^[「『"'：:，,、\s]+/, '')
    .replace(/[」』"']+$/g, '')
    .trim();
  if (body.length < 2) return null;
  return { action: 'remember', body };
}

/**
 * 「忘掉 xxx」「忘了 xxx」「删掉记忆 xxx」「忘掉刚才记的」
 * @returns {{action:'forget', body:string, last?:boolean}|null}
 */
function parseForget(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^(?:忘掉|忘了|删掉|清除)(?:你)?(?:刚才|刚刚|上一条|最后|那条)(?:记的|记忆|备忘)?[了吧。！!]*$/.test(t)) {
    return { action: 'forget', body: '', last: true };
  }
  const m = t.match(/^(?:忘掉|忘了|删掉|清除)(?:关于)?[：:，,、\s]*(.{1,60})$/s);
  if (!m) return null;
  return { action: 'forget', body: m[1].trim() };
}

/* ───────────────────────── 自动提炼：哪些话值得记 ───────────────────────── */

/** 关于主人自己的事实（自我介绍、习惯、喜好、雷点、身份） */
const FACT_RULES = [
  { re: /(?:我|俺|咱)(?:叫|就是|是|的(?:专业|工作|学校|名字|号|生日|年龄|老家|宿舍|爱好|习惯))/, imp: 4, kind: 'fact' },
  { re: /我(?:喜欢|爱|讨厌|不喜欢|受不了|最怕|怕|习惯|每天|一般|通常|平时)/, imp: 4, kind: 'preference' },
  { re: /我(?:们|俩|俩个)(?:的|约|说好|每周|每天|以后|一直)/, imp: 4, kind: 'fact' },
  { re: /我(?:的|这里|那边|这|那)(?:\.{0,3})(?:叫|是|在|有|住)/, imp: 3, kind: 'fact' },
];

/** 约定 / 承诺 / 时间点 */
const PROMISE_RULES = [
  { re: /(?:明天|后天|下周|下个月|周末|今晚|周末).{0,8}(?:要|得|去|约|考试|比赛|面试|回家|见面)/, imp: 4, kind: 'promise' },
  { re: /(?:说好了|答应|约好|记住咱们|每次都|以后都|从现在开始)/, imp: 4, kind: 'promise' },
];

/** 临时的事：会淡出 */
const EVENT_RULES = [
  { re: /我(?:今天|刚刚|刚才|现在|正在|在)(?:在|去|做了|吃了|看了|玩了|睡了|上课|上班|写|学)/, imp: 2, kind: 'event' },
];

// 看起来像「问句 / 反问 / 假设」的，一律不当成事实记住。
// 踩过的坑：曾经把「你知道我是做什么的吗」「我是什么印象」「那我是不是不能找别的姑娘了」
// 当成「关于他的事实」存进长期记忆，之后又原样塞回提示词，等于教她记错人。
const NOT_A_FACT_RES = [
  /[？?]\s*$/,
  /(吗|嘛|么|呢)\s*$/,
  /(什么|怎么|为什么|为啥|咋|哪|谁|多少|几个|几点|多久|是不是|能不能|要不要|可不可以|有没有|会不会|行不行|对不对|好不好)/,
  /^(那|这|就|才|还|又|也|但|可|可是|所以|然后|其实|不过)/,
  /^(的|了|呢|吧|啊|呀|哦|嗯)/,
];

function looksLikeQuestion(t) {
  return NOT_A_FACT_RES.some((re) => re.test(t));
}

function autoExtract(text) {
  const t = String(text || '').trim();
  if (t.length < 5 || t.length > 300) return null;
  // 只有「陈述句」才可能是事实；问句、以虚词开头的残片、纯语气词都跳过
  if (looksLikeQuestion(t)) return null;
  for (const r of PROMISE_RULES) if (r.re.test(t)) return { text: t, importance: r.imp, kind: r.kind };
  for (const r of FACT_RULES) if (r.re.test(t)) return { text: t, importance: r.imp, kind: r.kind };
  for (const r of EVENT_RULES) if (r.re.test(t)) return { text: t, importance: r.imp, kind: r.kind };
  return null;
}

/* ───────────────────────── 工具 ───────────────────────── */

function norm(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：,.!?;:（）()【】[\]「」『』"'`~\-—_]+/g, '')
    .toLowerCase();
}

/** 字级 bigram 集合，用来算「像不像」 */
function bigrams(s) {
  const set = new Set();
  const t = String(s || '');
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** 相似度：重叠 bigram / 较短一方 */
function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / Math.min(A.size, B.size);
}

/** 和查询的相关度（0~1），叠加重要度和新鲜度 */
function scoreOf(item, query, now) {
  const q = norm(query);
  const body = norm(item.text);
  let base = similarity(q, body);
  // 关键词命中：查询里的 2 字词在记忆里出现过，也算一点
  if (!base && q.length >= 2) {
    for (let i = 0; i < q.length - 1; i++) {
      if (body.includes(q.slice(i, i + 2))) {
        base += 0.15;
        if (base >= 0.6) break;
      }
    }
  }
  const impBoost = (item.importance || 3) / 20; // 5 → +0.25
  const ageDays = Math.max(0, (now - (item.at || now)) / 864e5);
  const freshBoost = ageDays < 7 ? 0.12 : ageDays < 30 ? 0.06 : 0;
  return Math.min(1, base + impBoost + freshBoost);
}

function shortText(t, n = 120) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ───────────────────────── 主对象 ───────────────────────── */

/**
 * @param {{file:string, log?:object, cfg?:object, now?:()=>number}} opts
 */
function createLongTerm({ file, log = null, cfg = {}, now = () => Date.now() } = {}) {
  const opt = { ...LONGTERM_DEFAULTS, ...(cfg || {}) };
  let store = { version: 1, items: [] };
  let autoDay = ''; // '2026-10-28'
  let autoCount = 0;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && Array.isArray(raw.items)) store = raw;
      if (raw && raw.autoDay) {
        autoDay = raw.autoDay;
        autoCount = raw.autoCount || 0;
      }
    } catch {
      store = { version: 1, items: [] };
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...store, autoDay, autoCount }, null, 2), 'utf8');
    } catch (e) {
      log?.warn?.(`长期记忆：写盘失败 ${e.message}`);
    }
  }

  function dayKey(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function newId(ts) {
    return `m${ts.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /**
   * 存一条。相同内容（或高度相似）只更新，不重复存。
   * @returns {{ok:boolean, action:'added'|'updated'|'duplicate'|'skipped', item?:object, reason?:string}}
   */
  function remember({ text, subject = 'global', importance = 3, kind = 'fact', source = 'owner', at = now(), private: isPrivate = false } = {}) {
    if (!opt.enabled) return { ok: false, action: 'skipped', reason: 'disabled' };
    const body = shortText(text, opt.maxChars);
    if (!body || body.length < 2) return { ok: false, action: 'skipped', reason: 'too-short' };
    const k = norm(body);
    const dup = store.items.find(
      (it) => it.subject === subject && (norm(it.text) === k || similarity(norm(it.text), k) > 0.8)
    );
    if (dup) {
      dup.importance = Math.max(dup.importance || 3, importance);
      dup.at = at;
      dup.usedAt = at;
      dup.hits = (dup.hits || 0) + 1;
      if (importance >= 5) dup.source = source;
      if (isPrivate) dup.private = true;
      save();
      return { ok: true, action: 'updated', item: dup };
    }
    const item = {
      id: newId(at),
      subject,
      text: body,
      kind: KINDS.includes(kind) ? kind : 'fact',
      importance: Math.max(1, Math.min(5, Number(importance) || 3)),
      source,
      at,
      usedAt: 0,
      hits: 0,
    };
    if (isPrivate) item.private = true;
    store.items.push(item);
    prune();
    save();
    log?.info?.(`长期记忆：记下「${shortText(body, 30)}」（重要度 ${item.importance}）`);
    return { ok: true, action: 'added', item };
  }

  /** 忘掉：给了内容就按内容匹配，只给 last 就删最近一条 */
  function forget({ text = '', subject = null, last = false } = {}) {
    const before = store.items.length;
    if (last) {
      const idx = [...store.items]
        .map((it, i) => ({ it, i }))
        .filter(({ it }) => !subject || it.subject === subject)
        .sort((a, b) => (b.it.at || 0) - (a.it.at || 0))[0];
      if (idx) store.items.splice(store.items.indexOf(idx.it), 1);
    } else {
      const k = norm(text);
      if (!k) return { ok: false, removed: 0 };
      store.items = store.items.filter((it) => {
        if (subject && it.subject !== subject) return true;
        const b = norm(it.text);
        return !(b.includes(k) || k.includes(b) || similarity(b, k) > 0.6);
      });
    }
    const removed = before - store.items.length;
    if (removed) save();
    return { ok: removed > 0, removed };
  }

  /** 条数超了：先丢 importance 低且老的 */
  function prune() {
    if (store.items.length <= opt.maxItems) return;
    store.items.sort((a, b) => {
      const imp = (b.importance || 3) - (a.importance || 3);
      if (imp) return imp;
      return (b.usedAt || b.at || 0) - (a.usedAt || a.at || 0);
    });
    store.items = store.items.slice(0, opt.maxItems);
  }

  /**
   * 召回：这次说话要带哪些记忆。
   * 规则：subject 自己的 + 全局的；高重要度（>=5）无条件带；其余按相关度。
   */
  function recall({ query = '', subject = null, limit = opt.recallLimit, nowTs = now(), includePrivate = false } = {}) {
    if (!opt.enabled || !store.items.length) return [];
    // private 条目只给主人本人看：别人私聊/群聊里一律不召回（防止把他的身份说漏）
    const pool = store.items.filter((it) => {
      if (it.private && !includePrivate) return false;
      return !subject || it.subject === subject || it.subject === 'global';
    });
    const scored = pool
      .map((it) => ({ it, score: scoreOf(it, query, nowTs) }))
      .sort((a, b) => b.score - a.score);

    const picked = [];
    const seen = new Set();
    // 1. 高优先级（主人交代过的）优先带
    for (const { it } of scored) {
      if (picked.length >= opt.maxPinned) break;
      if ((it.importance || 3) >= 5) {
        picked.push(it);
        seen.add(it.id);
      }
    }
    // 2. 再按相关度补
    for (const { it, score } of scored) {
      if (picked.length >= limit) break;
      if (seen.has(it.id)) continue;
      if (score < opt.minScore) continue;
      picked.push(it);
      seen.add(it.id);
    }
    // 3. 如果一条都没命中，至少带上最近的一条关于他的事
    if (!picked.length) {
      const latest = [...pool].sort((a, b) => (b.at || 0) - (a.at || 0))[0];
      if (latest) picked.push(latest);
    }
    // 记一次「被用到」，用于淘汰判断
    const ts = nowTs;
    for (const it of picked) {
      it.usedAt = ts;
      it.hits = (it.hits || 0) + 1;
    }
    if (picked.length) save();
    return picked;
  }

  /** 拼成提示词里的一段 */
  function format(items) {
    if (!items || !items.length) return '';
    const lines = items.map((it) => {
      const d = it.at ? new Date(it.at).toISOString().slice(0, 10) : '';
      const tag =
        it.kind === 'promise' ? '约定' : it.kind === 'preference' ? '他的喜好' : it.kind === 'rule' ? '规矩' : it.kind === 'event' ? '最近的事' : '关于他';
      return `- [${tag}${d ? ' ' + d : ''}] ${shortText(it.text, 100)}`;
    });
    return lines.join('\n');
  }

  /** 自动提炼（只在主人私聊里用，每天限量） */
  function observe({ text, subject = null, fromOwner = false, at = now() } = {}) {
    if (!opt.enabled || !fromOwner || !subject) return { saved: false, reason: 'skip' };
    const day = dayKey(at);
    if (day !== autoDay) {
      autoDay = day;
      autoCount = 0;
    }
    if (autoCount >= opt.autoPerDay) return { saved: false, reason: 'daily-limit' };
    const cand = autoExtract(text);
    if (!cand) return { saved: false, reason: 'no-match' };
    const res = remember({
      text: cand.text,
      subject,
      importance: cand.importance,
      kind: cand.kind,
      source: 'auto',
      at,
    });
    if (res.action === 'added') {
      autoCount++;
      save();
    }
    return { saved: res.action === 'added', item: res.item, reason: res.action };
  }

  /** 「上下文失效就清掉」的那部分：低重要度的老记忆淡出 */
  function tick({ nowTs = now() } = {}) {
    if (!opt.enabled) return { removed: 0 };
    const cutoff = nowTs - opt.decayDays * 864e5;
    const before = store.items.length;
    store.items = store.items.filter((it) => {
      if ((it.importance || 3) > 2) return true;
      if ((it.source || '') === 'owner') return true; // 主人交代的不丢
      const last = Math.max(it.usedAt || 0, it.at || 0);
      return last >= cutoff;
    });
    const removed = before - store.items.length;
    if (removed) save();
    return { removed };
  }

  function list({ subject = null } = {}) {
    const pool = subject ? store.items.filter((it) => it.subject === subject) : store.items;
    return [...pool].sort((a, b) => (b.importance || 3) - (a.importance || 3) || (b.at || 0) - (a.at || 0));
  }

  function stats() {
    const byImp = {};
    for (const it of store.items) byImp[it.importance] = (byImp[it.importance] || 0) + 1;
    return { total: store.items.length, byImportance: byImp, autoToday: autoCount };
  }

  load();
  return {
    remember,
    forget,
    recall,
    format,
    observe,
    tick,
    list,
    stats,
    parseRemember,
    parseForget,
    autoExtract,
    get enabled() {
      return !!opt.enabled;
    },
    file,
  };
}

module.exports = {
  createLongTerm,
  parseRemember,
  parseForget,
  autoExtract,
  similarity,
  LONGTERM_DEFAULTS,
};
