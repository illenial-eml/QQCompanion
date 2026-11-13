'use strict';

/**
 * 内心深处（innerlife）—— 让「她」记住跟他之间还没完结的事、重要的日子、以及他最近过得怎么样。
 *
 * 为什么要有这个模块（2026-11-13，参考 AstrBot 陪伴插件的设计）：
 *   原来的记忆是「他说过的事实」（longterm.json），但人跟人之间真正有温度的是这些：
 *     1) 未完话头：他说明天要考试、他在等一个结果 —— 过两天她应该会问一句；
 *     2) 重要的日子：生日、纪念日、约好的时间 —— 到点她心里有数；
 *     3) 他最近怎么样：不是流水账，是一句「他这阵子在忙什么、心情如何」。
 *   这三样都不适合塞进长期记忆（会互相淹没），单独存、单独注入提示词，不占聊天历史。
 *
 * 数据：data/inner.json（threads / dates / owner 三段，一个文件，好备份）
 * 反思：每晚 23:40 跟日记前后脚跑一次，从「今天他跟我说过的话」里用小模型抽出来。
 *
 * 设计原则：
 *   - 纯数据 + 一次模型调用，不主动发消息（他要的是「人格更丰富」不是「更烦人」）。
 *   - 只对主人私聊生效（group 里不注入，免得把他的私事说漏）。
 *   - 所有调用失败都静默降级：没有数据就是空字符串，提示词里不会多出一段空标题。
 */

const fs = require('fs');
const path = require('path');

const INNER_DEFAULTS = {
  enabled: true,
  file: 'data/inner.json',
  reflectEnabled: true,
  reflectHour: 23,
  reflectMinute: 40,
  minTurns: 4,          // 今天至少聊了这么多句才值得反思（不然浪费一次模型）
  maxThreads: 40,       // 同时在挂的未完话头上限
  maxDates: 60,
  threadDays: 21,       // 这么久还没结果的话头就淡出（不再提）
  injectThreads: 4,     // 提示词里最多带几条
  injectDates: 3,
  maxChars: 500,        // 注入的整段最长多少字
  timeoutMs: 40000,
};

const BJ = 8 * 3600000;
const DAY = 86400000;

function bjParts(ms) {
  const d = new Date(Number(ms) + BJ);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

function dayNum(ms) {
  return Math.floor((Number(ms) + BJ) / DAY);
}

function ymd(ms) {
  const p = bjParts(ms);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' / 'M月D日' / 'M-D' → 北京日期的天数编号（只保留日期部分） */
function parseDue(text, nowMs) {
  const s = String(text || '').trim();
  if (!s) return 0;
  const base = bjParts(nowMs);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return Math.floor((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + BJ) / DAY);
  m = s.match(/^(\d{1,2})[月\-/](\d{1,2})[日号]?$/);
  if (m) {
    const mo = Number(m[1]);
    const da = Number(m[2]);
    let y = base.y;
    if (mo < base.m - 6) y += 1; // 跨年（说「1月3日」而现在是 12 月）
    return Math.floor((Date.UTC(y, mo - 1, da) + BJ) / DAY);
  }
  return 0;
}

function dueLabel(dueDay, nowMs) {
  if (!dueDay) return '';
  const diff = dueDay - dayNum(nowMs);
  if (diff === 0) return '就是今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff > 0) return `还有 ${diff} 天`;
  if (diff === -1) return '昨天';
  return `已经过去 ${-diff} 天`;
}

/** 两个中文短句像不像在说同一件事（跟 responder 里的 simText 一个思路，这里自足） */
function sim(a, b) {
  const x = String(a || '').replace(/[\s，。,.！!？?、；;：:]/g, '');
  const y = String(b || '').replace(/[\s，。,.！!？?、；;：:]/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) / Math.max(x.length, y.length) + 0.35;
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(x);
  const gb = grams(y);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return (2 * hit) / (ga.size + gb.size);
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 两句话最长公共子串长度（用来判断「他说的是不是这件挂着的事」，比整体相似度宽容） */
function lcsLen(a, b) {
  const x = String(a || '').replace(/[\s，。,.！!？?、；;：:]/g, '');
  const y = String(b || '').replace(/[\s，。,.！!？?、；;：:]/g, '');
  if (!x || !y) return 0;
  const m = x.length;
  const n = y.length;
  if (m * n > 40000) return sim(a, b) > 0.4 ? 4 : 2; // 太长就不算，别拖慢
  let best = 0;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

function extractJson(raw) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

const REFLECT_SYSTEM = [
  '你叫水鸡，是个在 QQ 上跟人聊天的女孩子。现在给你看**你主人今天跟你说的原话**。',
  '你要做的不是写总结，而是像人一样把几件真正值得记住的事挑出来，留到以后自然提起。',
  '',
  '规则：',
  '1. 只用他原话里真实出现过的信息，一个字都不许编；拿不准的不要写。',
  '2. 「facts」是他身上长期成立的客观事实或偏好（工作/学校/专业/作息/口味/讨厌什么/身体状况），最多 3 条，每条一句不超过 40 字。',
  '3. 「threads」是**还没完结的事**：他说明天/下周要做的、在等的、答应过的、还没做完的。要清楚到以后能问一句「那事怎么样了」。最多 3 条。',
  '   due 填日期（YYYY-MM-DD，按今天往后推；说不清就填 ""）。',
  '4. 「closed」是以前挂着、今天他明确说了结果/已经过去的事，填你看到的原话片段（没有就空数组）。',
  '5. 「dates」是明确的重要日子：生日、纪念日、约好的日子。date 填 MM-DD（或 YYYY-MM-DD），yearly 表示每年都有。没提到就空数组。',
  '6. 「last」用一两句话写他最近怎么样（在忙什么、心情如何），25 字以内，不要复述原话。',
  '只输出 JSON，不要解释。格式：',
  '{"facts":[{"text":"...","importance":1-5}],"threads":[{"text":"...","due":""}],"closed":["..."],"dates":[{"label":"...","date":"MM-DD","yearly":true}],"last":"..."}',
].join('\n');

function createInnerLife({ file, cfg = {}, log = null, now = () => Date.now() } = {}) {
  const conf = { ...INNER_DEFAULTS, ...(cfg || {}) };
  const stateFile = file || conf.file;
  let st = { threads: [], dates: [], owner: {}, anniversaries: {}, updatedAt: 0 };
  let loaded = false;

  function load() {
    if (loaded) return st;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        st = {
          threads: Array.isArray(raw.threads) ? raw.threads : [],
          dates: Array.isArray(raw.dates) ? raw.dates : [],
          owner: raw.owner && typeof raw.owner === 'object' ? raw.owner : {},
          updatedAt: Number(raw.updatedAt) || 0,
          lastReflectDay: raw.lastReflectDay || '',
          lastReflectAt: Number(raw.lastReflectAt) || 0,
        };
      }
    } catch {
      /* 没有就是空的 */
    }
    return st;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      st.updatedAt = Date.now();
      fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8');
    } catch (e) {
      log?.warn?.('内心深处：写不进去 ' + e.message);
    }
  }

  function nextId(prefix, list) {
    let max = 0;
    for (const it of list) {
      const m = String(it.id || '').match(/(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}${max + 1}`;
  }

  /** 记一件还没完的事（重复的不重复记） */
  function addThread(text, { due = '', who = 'owner', at = null } = {}) {
    load();
    const t = clip(text, 80);
    if (!t) return null;
    for (const th of st.threads) {
      if (th.status !== 'open') continue;
      if (sim(th.text, t) > 0.6) {
        if (due) th.due = due;
        th.at = at || Date.now();
        save();
        return th;
      }
    }
    const item = {
      id: nextId('t', st.threads),
      text: t,
      due: due || '',
      who,
      status: 'open',
      at: at || Date.now(),
      hits: 0,
    };
    st.threads.push(item);
    // 淡出旧话头 + 上限
    const nowMs = now();
    st.threads = st.threads.filter((x) => {
      if (x.status !== 'open') return true;
      const age = dayNum(nowMs) - dayNum(x.at || nowMs);
      return age <= Number(conf.threadDays);
    });
    const open = st.threads.filter((x) => x.status === 'open');
    if (open.length > Number(conf.maxThreads)) {
      const drop = open.slice(0, open.length - Number(conf.maxThreads));
      for (const d of drop) d.status = 'dropped';
    }
    save();
    return item;
  }

  /**
   * 他说了新的一句话，看看有没有把挂着的事说完了（比如「考完了」「那个offer拿到了」）。
   * 便宜的本地判断：相似度 + 结局词。命中就关掉，返回关掉的条目。
   */
  function noteOwnerText(text) {
    load();
    const t = String(text || '').trim();
    if (!t) return [];
    const DONE = /(考完|考过了|完事了|搞定了|办完了|拿到了|拿到offer|接了|录取了|通过了|结束了|成功了|做完了|交了|面试完|过了|不好|失败了|没戏|取消了|不去了|算了)/;
    const closed = [];
    for (const th of st.threads) {
      if (th.status !== 'open') continue;
      const s = sim(th.text, t);
      const doneWord = DONE.test(t);
      if (s >= 0.75) {
        th.status = 'done';
        th.doneAt = Date.now();
        closed.push(th);
      } else if (doneWord && (s >= 0.34 || lcsLen(th.text, t) >= 2)) {
        // 「高数考完了」这种：整体不像，但带着同一件事的关键词 + 结局词
        th.status = 'done';
        th.doneAt = Date.now();
        closed.push(th);
      } else if (doneWord && th.hits === 0 && s >= 0.2) {
        // 先记一次「他提到过」，下次再像就直接关
        th.hits = 1;
      }
    }
    if (closed.length) save();
    return closed;
  }

  /**
   * 主人说「别惦记 X 了」：把最像的那条挂心事标记成 dropped（不再注入、也不在清单里出现）。
   * 找不到就返回 null，让上层老实说「我记着的里面没这件事」。
   */
  function dropThread(query) {
    load();
    const q = String(query || "").trim();
    if (!q) return null;
    const open = st.threads.filter((x) => x.status === "open");
    if (!open.length) return null;
    let best = null;
    let bestScore = 0;
    for (const th of open) {
      const sc = sim(th.text, q);
      const inc = th.text.includes(q) || q.includes(th.text) ? 0.9 : 0;
      const total = Math.max(sc, inc);
      if (total > bestScore) { bestScore = total; best = th; }
    }
    if (!best || bestScore < 0.3) return null;
    best.status = "dropped";
    best.droppedAt = Date.now();
    save();
    return best;
  }

  function addDate({ label = '', date = '', yearly = true, kind = 'date', at = null } = {}) {
    load();
    const l = clip(label, 24);
    const d = String(date || '').trim();
    if (!l || !d) return null;
    for (const x of st.dates) {
      if (x.label === l) {
        x.date = d;
        x.yearly = !!yearly;
        x.kind = kind;
        x.at = at || Date.now();
        save();
        return x;
      }
    }
    const item = { id: nextId('d', st.dates), label: l, date: d, yearly: !!yearly, kind, at: at || Date.now() };
    st.dates.push(item);
    if (st.dates.length > Number(conf.maxDates)) st.dates = st.dates.slice(-Number(conf.maxDates));
    save();
    return item;
  }

  /** 值得提的日子：一周、一个月、五十天、整百天、周年 */
  const MILESTONES = [7, 30, 50, 100, 200, 300, 365, 500, 730, 1000, 1095, 1460];

  /**
   * 今天是认识第几天？如果正好是值得提的日子、且还没提过，返回 { days, text }。
   * since 用「第一次说话的时间戳」（people.json 里的 firstSeen）。
   */
  function anniversaryFor({ since = 0, nowMs = now() } = {}) {
    load();
    const t0 = Number(since) || 0;
    if (!t0) return null;
    const days = Math.floor((nowMs - t0) / (24 * 3600 * 1000)) + 1;
    if (days < 2) return null;
    const hit = MILESTONES.includes(days) || (days > 1000 && days % 365 === 0);
    if (!hit) return null;
    st.anniversaries = st.anniversaries && typeof st.anniversaries === 'object' ? st.anniversaries : {};
    if (st.anniversaries[days]) return null;
    st.anniversaries[days] = nowMs;
    // 只保留最近 10 条，别让文件膨胀
    const keys = Object.keys(st.anniversaries).map(Number).sort((a, b) => b - a);
    if (keys.length > 10) {
      const keep = {};
      for (const k of keys.slice(0, 10)) keep[k] = st.anniversaries[k];
      st.anniversaries = keep;
    }
    save();
    const word = days === 365 ? '一整年' : days === 100 ? '一百天' : `${days} 天`;
    return { days, text: `今天是你和他认识第 ${word}的日子（第 ${days} 天）` };
  }

  function setOwner({ last = '', at = null } = {}) {
    load();
    const t = clip(last, 60);
    if (!t) return null;
    st.owner = { ...st.owner, last: t, at: at || Date.now() };
    save();
    return st.owner;
  }

  /** 挂在身上的未完话头（到期/过期的排前面） */
  function openThreads({ limit = conf.injectThreads } = {}) {
    load();
    const nowMs = now();
    const list = st.threads
      .filter((x) => x.status === 'open')
      .map((x) => ({ ...x, dueDay: x.due ? parseDue(x.due, nowMs) : 0 }))
      .sort((a, b) => {
        if (a.dueDay && b.dueDay) return a.dueDay - b.dueDay;
        if (a.dueDay) return -1;
        if (b.dueDay) return 1;
        return (a.at || 0) - (b.at || 0);
      });
    return list.slice(0, limit);
  }

  /** 快到/已经到了的日子 */
  function upcomingDates({ days = 21, limit = conf.injectDates } = {}) {
    load();
    const nowMs = now();
    const today = dayNum(nowMs);
    const base = bjParts(nowMs);
    const out = [];
    for (const x of st.dates) {
      const d = String(x.date || '');
      let md = d.match(/^(\d{1,2})-(\d{1,2})$/);
      let target = 0;
      if (md) {
        const mo = Number(md[1]);
        const da = Number(md[2]);
        target = Math.floor((Date.UTC(base.y, mo - 1, da) + BJ) / DAY);
        if (target < today) target = Math.floor((Date.UTC(base.y + 1, mo - 1, da) + BJ) / DAY);
      } else {
        target = parseDue(d, nowMs);
      }
      if (!target) continue;
      const diff = target - today;
      if (diff < 0 || diff > days) continue;
      out.push({ ...x, diff, label2: diff === 0 ? '今天' : `还有 ${diff} 天` });
    }
    out.sort((a, b) => a.diff - b.diff);
    return out.slice(0, limit);
  }

  /**
   * 给提示词的一小段。只在跟主人私聊时用。
   * 没内容就返回空字符串（提示词里不会多出空标题）。
   */
  function contextFor({ scene = 'c2c', owner = false, since = 0 } = {}) {
    if (conf.enabled === false) return '';
    if (scene !== 'c2c' || !owner) return '';
    const lines = [];
    const ths = openThreads();
    if (ths.length) {
      const nowMs = now();
      lines.push('## 你心里记着的事（合适就顺着提一句，不是每句都提）');
      for (const t of ths) {
        const dl = dueLabel(t.dueDay, nowMs);
        lines.push(`- ${t.text}${dl ? `（${dl}）` : ''}`);
      }
    }
    const ownerState = st.owner && st.owner.last ? String(st.owner.last) : '';
    if (ownerState) {
      lines.push('## 他最近');
      lines.push(ownerState);
    }
    const ann = anniversaryFor({ since });
    if (ann) {
      lines.push('## 今天是个日子');
      lines.push(`- ${ann.text}。想提就顺口带一句（别提第二次，也别煽情）。`);
    }
    const ds = upcomingDates();
    if (ds.length) {
      lines.push('## 你记着的日子');
      for (const d of ds) lines.push(`- ${d.label} ${d.date}（${d.label2}）`);
    }
    if (!lines.length) return '';
    let out = '\n' + lines.join('\n');
    if (out.length > Number(conf.maxChars)) out = out.slice(0, Number(conf.maxChars)) + '…';
    return out;
  }

  /**
   * 每晚反思：从「今天他跟她说的话」里抽事实 / 未完话头 / 重要日子 / 他的近况。
   * 返回 { ok, applied:{facts,threads,dates,last,closed} }，失败返回 ok:false 不抛。
   */
  async function reflect({ turns = [], dateText = '', brain = null, longterm = null, ownerId = '' } = {}) {
    if (conf.enabled === false || conf.reflectEnabled === false) return { ok: false, reason: 'disabled' };
    if (!brain || typeof brain._complete !== 'function') return { ok: false, reason: 'no-brain' };
    load();

    const lines = (turns || [])
      .filter((t) => t && t.content)
      .map((t) => `${t.role === 'user' ? '他' : '我'}：${clip(t.content, 120)}`)
      .slice(-60);
    if (lines.length < Number(conf.minTurns)) return { ok: false, reason: 'too-few-turns' };

    const threadLines = st.threads
      .filter((x) => x.status === 'open')
      .slice(-12)
      .map((x) => `- ${x.text}${x.due ? `（${x.due}）` : ''}`);
    const dateLines = st.dates.slice(-12).map((x) => `- ${x.label} ${x.date}`);

    let raw = '';
    try {
      raw = await brain._complete(
        [
          { role: 'system', content: REFLECT_SYSTEM },
          {
            role: 'user',
            content: [
              `今天是 ${dateText || ymd(now())}。`,
              '',
              '## 他今天跟我说的话',
              lines.join('\n'),
              '',
              '## 我之前记着的、还没完的事',
              threadLines.length ? threadLines.join('\n') : '（没有）',
              '',
              '## 我之前记着的日子',
              dateLines.length ? dateLines.join('\n') : '（没有）',
            ].join('\n'),
          },
        ],
        600,
        0.5,
        { timeoutMs: conf.timeoutMs }
      );
    } catch (e) {
      log?.warn?.('内心深处：反思调用失败 ' + (e && e.message));
      return { ok: false, reason: 'call-failed' };
    }

    const j = extractJson(raw);
    if (!j) {
      log?.warn?.('内心深处：反思输出不是 JSON，跳过');
      return { ok: false, reason: 'bad-json' };
    }

    const applied = { facts: 0, threads: 0, dates: 0, last: '', closed: 0 };

    // 1) 长期事实
    for (const f of (Array.isArray(j.facts) ? j.facts : []).slice(0, 3)) {
      const text = clip(f && f.text, 60);
      if (!text) continue;
      const importance = Math.min(5, Math.max(1, Number(f && f.importance) || 3));
      try {
        if (longterm && typeof longterm.remember === 'function') {
          const r = longterm.remember({ text, subject: ownerId || 'owner', importance, kind: 'fact', source: 'reflect' });
          if (r && r.ok !== false) applied.facts += 1;
        }
      } catch (e) {
        log?.debug?.('内心深处：写长期记忆失败 ' + e.message);
      }
    }

    // 2) 先把他说完了的事关掉
    for (const c of (Array.isArray(j.closed) ? j.closed : []).slice(0, 6)) {
      const t = clip(c, 80);
      if (!t) continue;
      for (const th of st.threads) {
        if (th.status !== 'open') continue;
        if (sim(th.text, t) >= 0.4) {
          th.status = 'done';
          th.doneAt = Date.now();
          applied.closed += 1;
        }
      }
    }

    // 3) 新的未完话头
    for (const t of (Array.isArray(j.threads) ? j.threads : []).slice(0, 3)) {
      const text = clip(t && t.text, 80);
      if (!text) continue;
      const due = String((t && t.due) || '').trim();
      const before = st.threads.length;
      addThread(text, { due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : '', who: 'owner' });
      if (st.threads.length !== before) applied.threads += 1;
    }

    // 4) 重要的日子
    for (const d of (Array.isArray(j.dates) ? j.dates : []).slice(0, 3)) {
      const label = clip(d && d.label, 24);
      const date = String((d && d.date) || '').trim();
      if (!label || !date) continue;
      const before = st.dates.length;
      addDate({ label, date, yearly: d.yearly !== false, kind: 'date' });
      if (st.dates.length !== before) applied.dates += 1;
    }

    // 5) 他最近怎么样
    if (j.last) {
      const last = clip(j.last, 60);
      if (last) {
        st.owner = { ...st.owner, last, at: Date.now() };
        applied.last = last;
      }
    }

    const todayKey = String(dayNum(now()));
    st.lastReflectDay = todayKey;
    st.lastReflectAt = Date.now();
    save();
    log?.info?.(
      `内心深处：今晚记下 事实 ${applied.facts} / 话头 ${applied.threads} / 日子 ${applied.dates} / 关掉 ${applied.closed}` +
        (applied.last ? `；他最近：${applied.last}` : '')
    );
    return { ok: true, applied };
  }

  /** 该不该反思了（每晚一次，到点才跑） */
  function shouldReflect(nowMs = now()) {
    if (conf.enabled === false || conf.reflectEnabled === false) return false;
    load();
    const p = bjParts(nowMs);
    const key = String(dayNum(nowMs));
    if (st.lastReflectDay === key) return false;
    const h = p.h;
    const mi = p.mi;
    const target = Number(conf.reflectHour) * 60 + Number(conf.reflectMinute);
    return h * 60 + mi >= target && h < 24;
  }

  function summary() {
    load();
    const open = st.threads.filter((x) => x.status === 'open');
    return {
      threads: open.length,
      dates: st.dates.length,
      hasOwnerState: !!(st.owner && st.owner.last),
      lastReflectAt: st.lastReflectAt || 0,
    };
  }

  function state() {
    load();
    return JSON.parse(JSON.stringify(st));
  }

  load();

  return {
    conf,
    addThread,
    addDate,
    dropThread,
    anniversaryFor: (opts) => anniversaryFor(opts),
    setOwner,
    noteOwnerText,
    openThreads,
    upcomingDates,
    contextFor,
    reflect,
    shouldReflect,
    summary,
    state,
    save,
  };
}

module.exports = {
  INNER_DEFAULTS,
  createInnerLife,
  parseDue,
  dueLabel,
  sim,
  ymd,
  dayNum,
  bjParts,
};
