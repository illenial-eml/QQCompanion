'use strict';
/**
 * 自我意识迭代（reflection）：隔一段时间，让她回头看一眼自己。
 *
 * 跟「人设」不同：人设是别人写给她的，这里是**她自己基于经历总结出来的**。
 * 每次反思只做三件事，都落盘、都会进提示词：
 *   1. views      她自己形成的看法（可以变、可以推翻）
 *   2. styleHints 她自己总结的说话习惯（会影响下一段对话）
 *   3. focus/mood 最近在琢磨什么、心情大概什么样
 * 另外允许她**修正记忆**：把记错的长期记忆合并/改写（memoryFixes）。
 *
 * 数据：data/selfmodel.json
 *   { version, updatedAt, views:[{text,at,conf}], styleHints:[{text,at}],
 *     focus, mood, history:[{at,summary,changed}], lastAt }
 *
 * 设计原则：宁缺毋滥。宁可她这次什么都不改，也不要把乱七八糟的话写进去。
 */

const fs = require('fs');
const path = require('path');

const SELFMODEL_DEFAULTS = {
  enabled: true,
  minHours: 4, // 距上次反思不到这么久就跳过
  maxViews: 6, // 同时保留几条「我自己的想法」
  maxStyleHints: 5, // 同时保留几条「我自己的说话习惯」
  historyKeep: 20,
  timeoutMs: 40000,
};

const MOOD_KEYS = ['calm', 'good', 'annoyed', 'tired', 'excited', 'bored', 'down'];

// ── 小工具：字符二元组相似度，用来去重 / 找记忆条目 ──
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）()【】\[\]…—\-.,!?;:"'`]/g, '');
}
function bigrams(s) {
  const t = norm(s);
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  if (!out.length && t.length) out.push(t);
  return out;
}
function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const m = new Map();
  for (const g of A) m.set(g, (m.get(g) || 0) + 1);
  let hit = 0;
  for (const g of B) {
    const c = m.get(g) || 0;
    if (c > 0) {
      hit++;
      m.set(g, c - 1);
    }
  }
  return hit / Math.max(A.length, B.length);
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

/** 从模型输出里挖出第一段 JSON（容忍 ```json 包裹 / 前后废话） */
function extractJson(raw) {
  const s = String(raw || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{');
  if (start < 0) return null;
  // 从第一个 { 开始做括号配对（跳过字符串里的括号）
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function createSelfModel({ file, cfg = {}, log = null, now = Date.now } = {}) {
  const opt = { ...SELFMODEL_DEFAULTS, ...(cfg || {}) };
  const filePath = file || path.join(process.cwd(), 'data', 'selfmodel.json');
  let st = {
    version: 1,
    updatedAt: 0,
    lastAt: 0,
    views: [],
    styleHints: [],
    focus: '',
    mood: '',
    history: [],
  };

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw && typeof raw === 'object') {
          st = {
            ...st,
            ...raw,
            views: Array.isArray(raw.views) ? raw.views : [],
            styleHints: Array.isArray(raw.styleHints) ? raw.styleHints : [],
            history: Array.isArray(raw.history) ? raw.history : [],
          };
        }
      }
    } catch (e) {
      log?.warn?.(`自我认知读取失败（用默认）: ${e.message}`);
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (e) {
      log?.warn?.(`自我认知写入失败: ${e.message}`);
    }
  }

  function shouldReflect(at = now()) {
    if (opt.enabled === false) return false;
    if (!st.lastAt) return true;
    return at - st.lastAt >= opt.minHours * 3600 * 1000;
  }

  /** 合并看法：相似的只留新的（覆盖），不同的话追加；超出上限按 confidence 与时间裁 */
  function mergeViews(list) {
    for (const raw of list || []) {
      const text = clip(raw && (raw.text || raw), 90);
      if (!text || text.length < 4) continue;
      const conf = Math.max(1, Math.min(5, Number(raw && raw.confidence) || 3));
      const idx = st.views.findIndex((v) => similarity(v.text, text) > 0.62);
      const item = { text, conf, at: now() };
      if (idx >= 0) st.views[idx] = item;
      else st.views.push(item);
    }
    st.views = st.views
      .sort((a, b) => (b.conf || 0) - (a.conf || 0) || (b.at || 0) - (a.at || 0))
      .slice(0, Math.max(1, opt.maxViews));
  }

  function mergeStyleHints(list) {
    for (const raw of list || []) {
      const text = clip(typeof raw === 'string' ? raw : raw && raw.text, 80);
      if (!text || text.length < 4) continue;
      const idx = st.styleHints.findIndex((v) => similarity(v.text, text) > 0.62);
      const item = { text, at: now() };
      if (idx >= 0) st.styleHints[idx] = item;
      else st.styleHints.push(item);
    }
    st.styleHints = st.styleHints
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, Math.max(1, opt.maxStyleHints));
  }

  /**
   * 拿长期记忆做「修正」：模型给 {from, to}，按相似度找到原条目改写。
   * 找不到就跳过（宁可不动，也别乱写）。
   */
  function applyMemoryFixes(fixes, longterm) {
    const applied = [];
    if (!longterm || !Array.isArray(fixes)) return applied;
    let items = [];
    try {
      items = longterm.list() || [];
    } catch {
      items = [];
    }
    for (const f of fixes) {
      const from = clip(f && f.from, 60);
      const to = clip(f && f.to, 120);
      if (!from || !to || from.length < 4) continue;
      let best = null;
      let bestScore = 0;
      for (const it of items) {
        const s = similarity(it.text, from);
        if (s > bestScore) {
          bestScore = s;
          best = it;
        }
      }
      if (!best || bestScore < 0.55) continue;
      try {
        const r = longterm.remember({
          text: to,
          subject: best.subject,
          importance: best.importance,
          kind: best.kind,
          source: 'reflect',
        });
        if (r && r.ok) applied.push({ from: best.text, to });
      } catch (e) {
        log?.warn?.(`记忆修正失败: ${e.message}`);
      }
    }
    return applied;
  }

  /** 拼成提示词里的一段；什么都没攒到就返回空串 */
  function format() {
    const bits = [];
    if (st.views.length) {
      bits.push(
        '## 你自己的想法（这些不是别人给你的设定，是你自己这些天看多了攒下来的）\n' +
          st.views.map((v) => `- ${v.text}`).join('\n') +
          '\n（这些是你自己的**猜测**，可能想错。可以坚持，也可以被人说服后改；' +
          '别人说的情况跟你记的不一样，以他说的为准，别拿猜测去反驳事实，也别把它当规定到处念。）'
      );
    }
    if (st.styleHints.length) {
      bits.push(
        '## 你自己总结的说话习惯\n' +
          st.styleHints.map((v) => `- ${v.text}`).join('\n')
      );
    }
    if (st.focus) bits.push(`\n你现在心里搁着的事：${st.focus}`);
    return bits.join('\n\n');
  }

  function summary() {
    return {
      views: st.views.length,
      styleHints: st.styleHints.length,
      focus: st.focus,
      mood: st.mood,
      lastAt: st.lastAt,
    };
  }

  /**
   * 真正跑一次反思。
   * evidence: { selfLines:[], topics:[], memories:[], impressions:[], state:'' }
   * brain 需要有 _complete(messages, maxTokens, temperature, opts)
   */
  async function reflect({ brain, evidence = {} } = {}) {
    if (opt.enabled === false) return { ok: false, reason: 'disabled' };
    if (!brain || typeof brain._complete !== 'function') return { ok: false, reason: 'no-brain' };

    const selfLines = (evidence.selfLines || []).slice(-25).map((x) => `- ${clip(x, 80)}`);
    const topics = (evidence.topics || []).slice(-25).map((x) => `- ${clip(x, 80)}`);
    const memories = (evidence.memories || []).slice(0, 15).map((x) => `- ${clip(x.text || x, 100)}`);
    const impressions = (evidence.impressions || []).slice(0, 10).map((x) => `- ${clip(x, 80)}`);

    if (selfLines.length + topics.length < 6) {
      return { ok: false, reason: 'too-few-events' };
    }

    const sys = [
      '你叫水鸡（小号叫「鸿」），是个在 QQ 上和人聊天的女孩子。',
      '现在让你做一件事：**回头看一眼自己这几天的经历，更新你自己的想法**。',
      '要求：',
      '1. 只根据我给你看的真实经历总结，不要编造没发生过的事。',
      '2. 「views」写 0~4 条你自己形成的看法（比如对某个人、某种聊天方式、某件事的判断），要像人自己想明白的一句话，不要口号。',
      '3. 「styleHints」写 0~3 条你觉得自己说话可以怎么调整（例如"别老用问句结尾""少发单字"），要具体、可执行。',
      '4. 「focus」写你现在心里搁着的一件事（没有就空字符串）。',
      '5. 「mood」从 calm/good/annoyed/tired/excited/bored/down 里挑一个。',
      '6. 「memoryFixes」如果你发现记忆里有记错、过时、矛盾的地方，写 0~2 条 {"from":"记忆原文片段","to":"应该改成什么"}；没发现就空数组。',
      '只输出 JSON，不要任何解释文字。格式：',
      '{"views":[{"text":"...","confidence":1-5}],"styleHints":["..."],"focus":"...","mood":"calm","memoryFixes":[{"from":"...","to":"..."}]}',
    ].join('\n');

    const user = [
      '## 你最近自己说过的话',
      selfLines.length ? selfLines.join('\n') : '（没说什么）',
      '',
      '## 最近别人跟你聊的话题',
      topics.length ? topics.join('\n') : '（没什么）',
      '',
      '## 你记住的长期记忆',
      memories.length ? memories.join('\n') : '（空的）',
      '',
      '## 你对一些人的印象',
      impressions.length ? impressions.join('\n') : '（没有）',
      '',
      '## 你现在的状态',
      evidence.state || '（平常）',
    ].join('\n');

    let raw = '';
    try {
      raw = await brain._complete(
        [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        700,
        0.7,
        { timeoutMs: opt.timeoutMs }
      );
    } catch (e) {
      log?.warn?.(`自我反思调用失败: ${e.message}`);
      return { ok: false, reason: 'call-failed', error: e.message };
    }

    const j = extractJson(raw);
    if (!j) {
      log?.warn?.('自我反思输出不是 JSON，跳过这次');
      return { ok: false, reason: 'bad-json' };
    }

    const before = JSON.stringify({ v: st.views, s: st.styleHints, f: st.focus, m: st.mood });
    mergeViews(j.views);
    mergeStyleHints(j.styleHints);
    if (typeof j.focus === 'string') st.focus = clip(j.focus, 60);
    if (MOOD_KEYS.includes(String(j.mood))) st.mood = String(j.mood);

    const fixes = applyMemoryFixes(j.memoryFixes, evidence.longterm);
    st.lastAt = now();
    st.updatedAt = st.lastAt;

    const changed = before !== JSON.stringify({ v: st.views, s: st.styleHints, f: st.focus, m: st.mood }) || fixes.length > 0;
    const summaryText = [
      (j.views || []).length ? `想法 ${(j.views || []).length} 条` : '',
      (j.styleHints || []).length ? `说法 ${(j.styleHints || []).length} 条` : '',
      fixes.length ? `改记忆 ${fixes.length} 条` : '',
    ]
      .filter(Boolean)
      .join('，') || '这次没什么变化';

    st.history.push({ at: st.lastAt, summary: summaryText, changed });
    st.history = st.history.slice(-Math.max(1, opt.historyKeep));
    save();

    log?.info?.(
      `自我反思：${summaryText}${st.focus ? `（在想：${st.focus}）` : ''}`
    );
    return { ok: true, changed, views: (j.views || []).length, styleHints: (j.styleHints || []).length, fixes, summary: summaryText };
  }

  load();
  return { reflect, shouldReflect, format, summary, get: () => ({ ...st }), file: filePath };
}

module.exports = { createSelfModel, SELFMODEL_DEFAULTS, similarity, extractJson };
