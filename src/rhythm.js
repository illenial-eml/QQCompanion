'use strict';
/**
 * 真人节奏：让机器人不像「自动回复机器」。
 *
 *   1. 把一条回复拆成 1–3 条短消息，一条一条发（真人打字是一条条蹦出来的）
 *   2. 每条之间等一个「打字时间」，第一条前面再等一个「看一眼」的延迟
 *   3. 用户连发好几条时，先等一小会儿，把这几条合成一轮再回（别一句一句对着回）
 *
 * 全都是纯函数 / 可注入的 timer，方便离线测试。
 */

const RHYTHM_DEFAULTS = {
  enabled: true,
  readDelayMinMs: 400,      // 收到消息后「低头看手机」的最短延迟
  readDelayMaxMs: 1600,     // 最长延迟
  charMs: 45,               // 每个字大概打多久（ms），用来估打字时间
  typingMaxMs: 3500,        // 打字时间上限
  bubbleGapMinMs: 350,      // 两条消息之间的停顿下限
  bubbleGapMaxMs: 1400,     // 停顿上限
  maxBubbles: 3,            // 一次最多拆成几条发
  maxCharsPerBubble: 50,    // 一条消息尽量不超过多少字（超了才并成一条长的）
  minCharsPerBubble: 3,     // 短于这个字数的碎句（「嗯。」）才和下一句并起来
  mergeBurst: true,         // 是否把连发消息合并成一轮
  mergeWindowMs: 700,       // 收到一条后等多久，看还有没有下一条
  mergeMaxWaitMs: 3000,     // 最多等这么久（超了就先回）
};

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function rand(a, b, rng) { return a + (b - a) * rng(); }

/** 按句末标点/换行切成句子，标点留在句尾 */
function splitSentences(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const out = [];
  let buf = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\n') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
    if ('。！？!?…'.includes(ch)) {
      // 「。。。」「？！」「……」这种连续标点一起收尾
      while (i + 1 < t.length && '。！？!?…～~'.includes(t[i + 1])) buf += t[++i];
      // 收尾标点后面的后引号/后括号也算这一句的（「他说"好。"」别把引号甩到下一句开头）
      while (i + 1 < t.length && '”’」』）)》】"\'）'.includes(t[i + 1])) buf += t[++i];
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * 把回复拆成几条「聊天消息」。
 * 基本一句一条；只有特别短的句子（比如「嗯。」「好。」）才会和下一句并起来；
 * 超过 maxBubbles 的部分并到最后一条里（不丢字）。
 */
function splitBubbles(text, { maxCharsPerBubble = 50, minCharsPerBubble = 3, maxBubbles = 3 } = {}) {
  const sentences = splitSentences(text);
  if (sentences.length <= 1) {
    const t = String(text || '').trim();
    return t ? [t] : [];
  }
  const bubbles = [];
  let cur = '';
  for (const s of sentences) {
    if (!cur) { cur = s; continue; }
    // 太短的碎句（「嗯。」）才和下一句并成一条，其余一句一条
    if (cur.length < minCharsPerBubble && cur.length + s.length <= maxCharsPerBubble) {
      cur += s;
      continue;
    }
    bubbles.push(cur);
    cur = s;
  }
  if (cur) bubbles.push(cur);

  const cap = Math.max(1, maxBubbles);
  if (bubbles.length > cap) {
    // 句子太多：按总长度均分成 cap 条，别把一大坨全塞进最后一条
    const target = Math.ceil(bubbles.join('').length / cap);
    const out = [];
    let cur = '';
    for (const s of sentences) {
      if (!cur) { cur = s; continue; }
      if (cur.length + s.length > target && out.length < cap - 1) {
        out.push(cur);
        cur = s;
      } else {
        // 合并两句时，前一句如果没标点又紧贴着下一句，补一个「，」
        // 否则「他说明天来」+「我说好」会被并成「他说明天来我说好」，读起来像少了个逗号
        const needComma = /[a-zA-Z0-9\u4e00-\u9fa5]$/.test(cur) && !/^[，。！？、；：,.!?]/.test(s);
        cur += (needComma ? '，' : '') + s;
      }
    }
    if (cur) out.push(cur);
    return out;
  }
  return bubbles;
}

/**
 * 每条消息之前等多久。
 *   第一条：看手机延迟 + 打字时间（短回复就不用打太久）
 *   之后：停顿 ≈ 打下一句的时间
 * 返回与 bubbles 等长的毫秒数组。
 */
function bubbleDelays(bubbles, rhythm = {}, rng = Math.random) {
  const r = { ...RHYTHM_DEFAULTS, ...rhythm };
  return bubbles.map((b, i) => {
    const typing = clamp(String(b).length * r.charMs, 250, r.typingMaxMs);
    if (i === 0) {
      return Math.round(rand(r.readDelayMinMs, r.readDelayMaxMs, rng) + Math.min(typing, 2000));
    }
    return Math.round(clamp(typing, r.bubbleGapMinMs, r.bubbleGapMaxMs) + rand(0, 200, rng));
  });
}

/**
 * 连发合并器：push(key, item) 后等 windowMs（有新消息就重新计时，最多等 maxWaitMs），
 * 然后把这段时间里的消息交给 merge(items) 合并，再用 onFlush(key, merged, items) 处理。
 */
function createBurstMerger({
  windowMs = RHYTHM_DEFAULTS.mergeWindowMs,
  maxWaitMs = RHYTHM_DEFAULTS.mergeMaxWaitMs,
  merge = (items) => items[items.length - 1],
  onFlush,
  timer = { set: setTimeout, clear: clearTimeout },
  now = Date.now,
} = {}) {
  const buffers = new Map();

  function flush(key) {
    const b = buffers.get(key);
    if (!b) return;
    buffers.delete(key);
    if (b.timer) timer.clear(b.timer);
    let merged;
    try {
      merged = merge(b.items);
    } catch {
      merged = b.items[b.items.length - 1];
    }
    try { onFlush?.(key, merged, b.items); } catch { /* 上层自己记日志 */ }
  }

  function push(key, item) {
    let b = buffers.get(key);
    if (!b) {
      b = { items: [], startedAt: now(), timer: null };
      buffers.set(key, b);
    }
    if (!b.items.length) b.startedAt = now();
    b.items.push(item);
    if (b.timer) timer.clear(b.timer);
    const elapsed = now() - b.startedAt;
    const wait = Math.max(30, Math.min(windowMs, maxWaitMs - elapsed));
    b.timer = timer.set(() => flush(key), wait);
    return b.items.length;
  }

  function flushAll() { for (const k of [...buffers.keys()]) flush(k); }

  return { push, flush, flushAll, pending: () => buffers.size };
}

/** 把连发的几条消息合成一条：内容按换行拼起来，其他字段取最新那条 */
function mergeMessages(items) {
  if (!items.length) return null;
  const last = items[items.length - 1];
  const parts = items.map((m) => String(m.content || '').trim()).filter(Boolean);
  return { ...last, content: parts.join('\n'), mergedCount: items.length };
}

module.exports = {
  RHYTHM_DEFAULTS,
  splitSentences,
  splitBubbles,
  bubbleDelays,
  createBurstMerger,
  mergeMessages,
};
