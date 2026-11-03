'use strict';
/**
 * 学他说话：从他自己发的消息里统计说话习惯，抽出几句原话当语气样本。
 * 纯函数，不联网、不依赖时间。
 *
 * 目的：让模型回话的长度、标点、语气贴近对方，而不是写一段工整的"分析"。
 */

const STYLE_DEFAULTS = {
  enabled: true,
  maxSamples: 5,      // 塞进提示词的原话条数
  minChars: 2,        // 太短的原话（"嗯""啊"）没有参考价值
  maxChars: 80,       // 太长的原话会把模型带成写长文
  samplePool: 12,     // 从最近多少条里挑
  minCount: 3,        // 少于这么多条消息就不统计（样本太少会跑偏）
  group: true,        // 群里也照他的语气说话（默认开）
  longMode: true,     // 私聊里让他多说一点（主人 2026-10-31 要求「每次回复不要总是几句话」）
  corpusPath: '',     // 你导入的聊天记录样本（tools/import-chat.js 生成的 data/style-corpus.json）
  minCorpus: 8,       // 聊天记录至少这么多条才优先用它，不够就退回用 QQ 里的原话
};

function len(s) {
  return [...String(s || '')].length;
}

function rate(list, re) {
  if (!list.length) return 0;
  return list.filter((t) => re.test(t)).length / list.length;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 统计一个人的说话习惯；texts = 他说过的话（越靠后越新） */
function analyze(texts = []) {
  const list = texts.map((t) => String(t || '').trim()).filter(Boolean);
  if (!list.length) return null;

  const lens = list.map(len);
  const total = lens.reduce((a, b) => a + b, 0);
  const sorted = [...lens].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  return {
    count: list.length,
    avgLen: round2(total / list.length),
    medianLen: median,
    maxLen: sorted[sorted.length - 1],
    shortRate: round2(rate(list, /^[\s\S]{0,12}$/)),      // 12 字以内算短句
    veryShortRate: round2(lens.filter((n) => n <= 6).length / list.length),
    periodRate: round2(rate(list, /[。.]\s*$/)),           // 句末带句号
    ellipsisRate: round2(rate(list, /…{1,}|\.{3,}/)),      // 爱用省略号
    questionRate: round2(rate(list, /[?？]/)),
    commaRate: round2(rate(list, /[，,]/)),
    exclaimRate: round2(rate(list, /[!！]/)),
    emojiRate: round2(rate(list, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)),
    particleRate: round2(rate(list, /[啊呗嘛呢吧哈啦喔哦嗷]/)), // 语气词
  };
}

/** 从他说过的话里挑几句当"语气样本"：去掉太短/太长/重复的，优先最近的 */
function pickSamples(texts = [], opts = {}) {
  const { maxSamples = STYLE_DEFAULTS.maxSamples, minChars = STYLE_DEFAULTS.minChars, maxChars = STYLE_DEFAULTS.maxChars, samplePool = STYLE_DEFAULTS.samplePool } = opts;
  const cleaned = texts
    .map((t) => String(t || '').trim().replace(/\s+/g, ' '))
    .filter((t) => {
      const n = len(t);
      if (n < minChars || n > maxChars) return false;
      if (/^[\/\[（(【<]/.test(t)) return false;        // 命令、标记
      if (/^https?:\/\//i.test(t)) return false;
      if (/^(在吗|在|嗯|哦|啊|好|ok|OK|哈+)$/.test(t)) return false; // 无信息量
      return true;
    });

  const pool = cleaned.slice(-samplePool);
  const out = [];
  const seen = new Set();
  // 从最新的往回挑，短句优先（短句最能代表随手打字的语气）
  for (const t of [...pool].reverse()) {
    const key = t.replace(/[，。！？…\s]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= maxSamples) break;
  }
  return out.reverse();
}

function avgLen(list = []) {
  if (!list.length) return 0;
  return list.reduce((n, t) => n + len(t), 0) / list.length;
}

/**
 * 看他的说话习惯有没有在变（最近 vs 之前）。
 * 样本不够两头各 10 句就不判断，免得瞎带节奏。
 */
function trend(texts = [], { recent = 40, minEach = 10 } = {}) {
  const list = texts.map((t) => String(t || '').trim()).filter(Boolean);
  if (list.length < minEach * 2) return null;
  const recentSize = Math.min(recent, Math.floor(list.length / 2));
  const recentList = list.slice(-recentSize);
  const olderList = list.slice(0, list.length - recentSize);
  if (recentSize < minEach || olderList.length < minEach) return null;
  const a = avgLen(olderList);
  const b = avgLen(recentList);
  if (!a) return null;
  return {
    olderAvg: round2(a),
    recentAvg: round2(b),
    delta: round2((b - a) / a),   // 负数 = 变短了
    olderCount: olderList.length,
    recentCount: recentList.length,
  };
}

/**
 * 从「导入的聊天记录」里均匀抽几句当语气样本。
 * 和 pickSamples 的区别：记录可能有上千句，只取最近 12 句会撞见 @人、长句、怪句子，
 * 这里跨整份记录等距抽，并且更严格地过滤（带 @、带链接、带长数字、纯标点、超长）。
 */
function corpusSamples(texts = [], opts = {}) {
  const { maxSamples = 2, minChars = 3, maxChars = 26 } = opts;
  const cleaned = (texts || [])
    .map((t) => String(t || '').trim().replace(/\s+/g, ' '))
    .filter((t) => {
      const n = len(t);
      if (n < minChars || n > maxChars) return false;
      if (t.includes('@')) return false;
      if (/https?:/i.test(t)) return false;
      if (/^[\/\[（(【<#!]/.test(t)) return false;
      if (/^[?？!！。.，,、…~～\s]+$/.test(t)) return false;
      if (/\d{4,}/.test(t)) return false;
      if (/^(在吗|在|嗯|哦|啊|好|ok|OK|哈+)$/.test(t)) return false;
      return true;
    });

  const seen = new Set();
  const uniqd = [];
  for (const t of cleaned) {
    const key = t.replace(/[，。！？…\s]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    uniqd.push(t);
  }
  if (!uniqd.length) return [];
  if (uniqd.length <= maxSamples) return uniqd;

  // 等距抽，跨整份记录，避免只看到某个时期的说话方式
  const out = [];
  const step = (uniqd.length - 1) / Math.max(1, maxSamples - 1);
  for (let i = 0; i < maxSamples; i++) {
    const t = uniqd[Math.min(uniqd.length - 1, Math.round(i * step))];
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 把统计结果 + 原话拼成提示词段落；样本不足时返回空字符串 */
function styleBlock(profile, samples = [], cfg = STYLE_DEFAULTS, opts = {}) {
  if (!profile || profile.count < (cfg.minCount || 3)) return '';

  const fromCorpus = opts.source === 'corpus';
  const fromLearned = opts.source === 'learned';
  const bits = [];
  if (fromCorpus) {
    bits.push(`这里统计了他自己挑出来的 ${profile.count} 句话（从聊天记录里来的），平均 ${profile.avgLen} 个字，一半左右不超过 ${profile.medianLen} 个字。`);
  } else if (fromLearned) {
    bits.push(`这里统计了他攒下来的 ${profile.count} 句话（平时聊出来的），平均 ${profile.avgLen} 个字，一半左右不超过 ${profile.medianLen} 个字。`);
  } else {
    bits.push(`他最近发了 ${profile.count} 条消息，平均 ${profile.avgLen} 个字，一半左右不超过 ${profile.medianLen} 个字。`);
  }
  const longMode = opts.longMode === true;
  if (profile.shortRate >= 0.6) {
    if (longMode) bits.push('他平时话都很短，但你主人明确说过「别每次都只回几句」，所以你可以比他长，不用照着他的短。');
    else bits.push('他几乎都是很短的一句，你回长了就是错。');
  }
  if (profile.periodRate <= 0.3) bits.push('他基本不给句子加句号，你也别每句都收个句号。');
  if (profile.ellipsisRate >= 0.2) bits.push('他偶尔用「……」拖一下语气。');
  if (profile.particleRate >= 0.3) bits.push('他说话带语气词（啊/呗/呢/吧/嘛这类）。');
  if (profile.emojiRate <= 0.1) bits.push('他不用 emoji 表情。');
  if (profile.questionRate <= 0.15) bits.push('他很少提问，基本都是陈述或吐槽。');

  // 他的说话方式在变的时候，跟着变（这是「逐渐」的另一半）
  const tr = opts.trend;
  if (longMode) {
    // 私聊：长度这件事优先听主人的（要多说），趋势只用来调语气，不压长度
    if (tr && tr.delta >= 0.35) bits.push('他最近话变长了，你也可以再多说半句。');
  } else if (tr && tr.delta <= -0.2) {
    bits.push(`他最近说话比之前更短了（早先平均 ${tr.olderAvg} 字，最近 ${tr.recentAvg} 字），你也跟着变短。`);
  } else if (tr && tr.delta >= 0.35) {
    bits.push(`他最近话变长了一点（早先平均 ${tr.olderAvg} 字，最近 ${tr.recentAvg} 字），可以多说半句，但别超两句。`);
  }

  const lines = [];
  lines.push('## 他平时怎么说话（照着这个来）');
  lines.push(bits.join(''));
  if (samples.length) {
    const title = fromCorpus
      ? '他挑出来的原话（只看语气和长度，不要复述内容）：'
      : fromLearned
        ? '他以前说过的原话（只看语气和长度，不要复述内容）：'
        : '他最近的原话（只看语气和长度，不要复述内容）：';
    lines.push(title);
    for (const s of samples) lines.push(`- ${s}`);
  }
  lines.push('规矩：');
  if (longMode) {
    lines.push('- 长度（重要）：他嫌过“每次只回几句”，所以要多说——但**多说的是条数，不是长度**：连发两三条短句（分行），每条 5~18 个字，加起来 25~60 个字；**绝对不要写成一条 40 字以上的长句**，那会变成他讨厌的书面腔。');
  } else {
    lines.push(`- 长度跟他差不多：一句 5~15 个字，不超过 ${Math.max(20, Math.round(profile.avgLen * 2))} 个字；一句为准，最多两句。`);
  }
  lines.push('- 不总结他刚说的话、不分析他的心理、不追问、不解释你自己怎么运作。');
  lines.push('- 不要用「行，那我…」「懂了，我确实…」「你说得对，我…」这类开头，很膈应。');
  lines.push('- 短句、口语、一句话一行（分行发，别堆成一段），行末不打句号；禁书面词：维度、内耗、捋、课题、情绪价值、边界感、某种程度上、值得注意的是、然而、因此、总之、综上、或许、不妨、说白了。一行超过 20 字必须用逗号断开。');

  // 他骂过「膈应」的回复，直接当反面教材塞进来（最多 3 条，太多反而占满上下文）
  const negs = (opts.negatives || []).filter(Boolean).slice(-3);
  if (negs.length) {
    lines.push('');
    lines.push('## 他嫌膈应过的话（别这么说）');
    for (const x of negs) lines.push(`- ${x}`);
  }
  return lines.join('\n');
}

module.exports = { STYLE_DEFAULTS, analyze, pickSamples, corpusSamples, styleBlock, trend };
