'use strict';
/**
 * 聊天记录导入：把用户挑出来的聊天记录（QQ / 微信导出或复制粘贴的文本）解析成
 * 「他说过的话」，只用于学语气。不联网、不写回 QQ/微信。
 *
 * 支持的文本格式（自动识别，可混用）：
 *   1. QQ 导出：`2026-10-25 11:20:31 昵称(12345678)` 换行接内容，消息之间空行
 *   2. 昵称在前：`昵称 2026-10-25 11:20:31` 换行接内容
 *   3. 行内标签：`昵称：内容` / `昵称: 内容`
 *   4. 纯粘贴（没有昵称）：加 --all-mine，整段都当成他自己说的
 *   5. Markdown 导出（WeChatMsg 之类导出的 .md）：
 *      `- \`2026-08-16 08:45\` **me**：我有A2的表`（`**me**` = 他自己说的）
 */
const fs = require('fs');
const path = require('path');

const CORPUS_DEFAULTS = { maxMessages: 800, maxChars: 80, minChars: 1 };

const HEADER_TIME_FIRST = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s+(.{1,40}?)\s*$/;
const HEADER_NAME_FIRST = /^(.{1,30}?)\s+(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
const INLINE_LABEL = /^([^：:\s]{1,24})[：:]\s*(.+)$/;
/** Markdown 导出：`- \`2026-08-16 08:45\` **me**：内容`（没有加粗发言人的是系统消息） */
const MD_LINE = /^[-*]\s+`?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?)`?\s*(?:\*\*(.{1,40}?)\*\*)?\s*[：:]?\s*(.*)$/;
const ME_LABELS = new Set(['me', '我', 'self', 'myself']);

/** 系统提示、表情占位、撤回通知这类不是「他说的话」 */
const NOISE = [
  /^\[?(图片|表情|动画表情|语音|视频|文件|链接|位置|转账|红包|卡券|小程序|聊天记录|音乐|名片)\]?$/,
  /撤回了一条消息/,
  /^(以下是新消息|以上是打招呼的内容|你已添加了|该消息类型暂不能展示)/,
  /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/,
  /^\d{1,2}:\d{2}(:\d{2})?$/,
  /^[-=_*]{3,}$/,   // Markdown 分隔线
];

function isNoise(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  return NOISE.some((re) => re.test(s));
}

/** `昵称(12345678)` / `昵称<abc@x.com>` → { name, uin } */
function splitSpeaker(raw) {
  const s = String(raw || '').trim().replace(/[:：]\s*$/, '');
  const m = s.match(/^(.+?)\s*[（(<]\s*([^)）>\s]+)\s*[)）>]\s*$/);
  if (m) return { name: m[1].trim(), uin: m[2].trim() };
  return { name: s, uin: '' };
}

function normName(s) {
  return String(s || '').trim().toLowerCase();
}

function matchesMe(speaker, me) {
  const raw = String(speaker || '').trim();
  if (ME_LABELS.has(raw.toLowerCase())) return true;
  if (!me || !me.length) return false;
  const { name, uin } = splitSpeaker(speaker);
  const cand = [normName(name), normName(uin)];
  return me.some((m) => cand.includes(normName(m)));
}

/**
 * 解析聊天记录文本。
 * @param {string} text 原始文本
 * @param {{me?: string[], allMine?: boolean}} opts me = 他的昵称/QQ号/备注；allMine = 整段都是他说的
 * @returns {{speaker: string, time: string, text: string, mine: boolean}[]}
 */
function parseChatText(text, { me = [], allMine = false } = {}) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const body = cur.lines.join('\n').trim();
    if (body && !isNoise(body)) {
      out.push({
        speaker: allMine ? '' : cur.speaker,
        time: cur.time,
        text: body,
        mine: allMine || matchesMe(cur.speaker, me),
      });
    }
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\u0000/g, '');
    const t = line.trim();

    if (!t) { flush(); continue; }

    // 0. Markdown 导出行首格式
    const md = t.match(MD_LINE);
    if (md) {
      flush();
      const speaker = (md[3] || '').trim();
      const body = (md[4] || '').trim();
      if (speaker && body) {
        out.push({
          speaker: allMine ? '' : speaker,
          time: `${md[1]} ${md[2]}`,
          text: body,
          mine: allMine || matchesMe(speaker, me),
        });
      }
      continue;
    }
    // 引用回复行、标题行等杂项
    if (/^[↳⤷>|#]/.test(t)) continue;
    // Markdown 导出的元信息（`- 类型：群聊`、`- 消息条数：22497` 这类没有时间的列表行）
    if (/^[-*]\s/.test(t)) continue;

    // 1. `时间 昵称` 头
    const h1 = t.match(HEADER_TIME_FIRST);
    if (h1) {
      flush();
      cur = { speaker: h1[3], time: `${h1[1]} ${h1[2]}`, lines: [] };
      continue;
    }

    // 2. `昵称 时间` 头
    const h2 = t.match(HEADER_NAME_FIRST);
    if (h2) {
      flush();
      cur = { speaker: h2[1], time: `${h2[2]} ${h2[3]}`, lines: [] };
      continue;
    }

    // 3. 行内 `昵称：内容`
    const inl = t.match(INLINE_LABEL);
    if (inl && !/^https?$/i.test(inl[1])) {
      flush();
      out.push({
        speaker: allMine ? '' : inl[1].trim(),
        time: '',
        text: inl[2].trim(),
        mine: allMine || matchesMe(inl[1], me),
      });
      continue;
    }

    // 4. 正文（属于上一条消息，或纯粘贴）
    if (allMine) {
      // 纯粘贴：一行就是一条消息，别把几行粘成一大段
      out.push({ speaker: '', time: '', text: t, mine: true });
      continue;
    }
    if (!cur) cur = { speaker: '', time: '', lines: [] };
    cur.lines.push(t);
  }
  flush();

  return out.map((m) => ({ ...m, text: m.text.slice(0, 300) }));
}

/** 清洗 + 过滤 + 去重，只留适合学语气的短消息 */
function selectMine(messages, opts = {}) {
  const { maxMessages = CORPUS_DEFAULTS.maxMessages, maxChars = CORPUS_DEFAULTS.maxChars, minChars = CORPUS_DEFAULTS.minChars } = opts;
  const seen = new Set();
  const out = [];
  for (const m of messages) {
    if (!m.mine) continue;
    let t = String(m.text || '').trim().replace(/\s+/g, ' ');
    if (!t || isNoise(t)) continue;
    if (/https?:\/\//i.test(t)) continue;                // 带链接的消息学不到语气
    if ([...t].length < minChars || [...t].length > maxChars) continue;
    if (t.startsWith('/')) continue;                     // 命令
    const key = t.replace(/[\s，。！？、…~～,.!?]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: t, at: m.time || '' });
    if (out.length >= maxMessages) break;
  }
  return out;
}

function stats(messages) {
  const total = messages.length;
  const mine = messages.filter((m) => m.mine).length;
  const lens = messages.filter((m) => m.mine).map((m) => [...String(m.text)].length);
  const avg = lens.length ? Math.round((lens.reduce((a, b) => a + b, 0) / lens.length) * 10) / 10 : 0;
  return { total, mine, avgLen: avg };
}

function loadCorpus(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || !Array.isArray(raw.messages)) return null;
    return raw;
  } catch {
    return null;
  }
}

function saveCorpus(file, { source = '', messages = [] }) {
  const payload = {
    source,
    updatedAt: new Date().toISOString(),
    count: messages.length,
    messages,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return payload;
}

function corpusTexts(corpus) {
  if (!corpus || !Array.isArray(corpus.messages)) return [];
  return corpus.messages.map((m) => (typeof m === 'string' ? m : m.text)).filter(Boolean);
}

module.exports = {
  CORPUS_DEFAULTS, parseChatText, selectMine, stats, loadCorpus, saveCorpus, corpusTexts, splitSpeaker,
};
