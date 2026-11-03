'use strict';
/**
 * 知识自学（knowledge-learn）
 *
 * 目标：让她**自己**从聊天里学知识，而不是全靠你手写资料。
 *
 * 只在两种情况下才记：
 *   1. 主人明确在教她 —— 「记住：xxx」「记一下」「xxx 的意思是 yyy」「xxx 叫做 yyy」
 *   2. 主人在纠正她 —— 「不是 A，是 B」「应该是 B」
 *
 * 群里其他人说的话不直接进知识库（防止被灌垃圾/被带偏）；但群里同一句话被
 * 主人复述过的，靠第 1 条自然进来。
 *
 * 存两块：
 *   - 索引：data/knowledge-learn.json（去重 + 计数 + 每日上限）
 *   - 正文：知识库/学来的/<标题>.md（人可读、可直接删改）
 */

const fs = require('fs');
const path = require('path');

const MAX_PER_DAY = 20;
const MIN_LEN = 6;
const MAX_LEN = 300;

/** 主人专门在教 —— 抽出 (标题, 正文) */
function parseTeach(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  // 记住：xxx / 记一下 xxx / 记下：xxx
  let m = t.match(/^(?:请)?(?:记住|记一下|记下|记着)[：:，,\s]*(.{4,})$/s);
  if (m) return { title: '', body: m[1].trim() };

  // A 的意思是 B
  m = t.match(/^(.{2,30}?)的(?:意思|含义|定义)(?:是|就是)[：:，,\s]*(.{2,200})$/s);
  if (m) return { title: m[1].trim(), body: `${m[1].trim()}：${m[2].trim()}` };

  // A 叫做 B / A 叫作 B / A 是 B 的缩写
  m = t.match(/^(.{2,30}?)(?:叫做|叫作|简称|即)[：:，,\s]*(.{2,80})$/s);
  if (m) return { title: m[1].trim(), body: `${m[1].trim()}：${m[2].trim()}` };

  // A 是 B 的缩写
  m = t.match(/^(.{2,20}?)是(.{2,40}?)的缩写$/s);
  if (m) return { title: m[1].trim(), body: `${m[1].trim()} 是 ${m[2].trim()} 的缩写` };

  return null;
}

/** 主人纠正她 —— 「不是 A，是 B」 */
function parseCorrection(text) {
  const t = String(text || '').trim();
  // 不是 A，是 B —— 最常见的纠正句式
  const m0 = t.match(/^不是(.{1,30}?)[，,]\s*(?:是|而是|应该是)(.+)$/s);
  if (m0) {
    const wrong = m0[1].trim();
    const right = m0[2].trim();
    if (right.length >= 2) return { title: wrong, body: `${wrong} → ${right}`, kind: 'correction' };
  }
  // 不对/错了，是 B
  const m = t.match(/^(?:不对|错了|不是这样的)[，,\s]*(?:是|应该是|而是|应该说)[：:，,\s]*(.+)$/s);
  if (m && m[1].trim().length >= 2) return { title: '', body: m[1].trim(), kind: 'correction' };
  const m2 = t.match(/^(.{2,20})(?:不是|不是这样)[，,](?:是|而是)(.+)$/s);
  if (m2) return { title: m2[1].trim(), body: `${m2[1].trim()} → ${m2[2].trim()}`, kind: 'correction' };
  return null;
}

function normBody(body) {
  return String(body || '').replace(/\s+/g, '').toLowerCase().slice(0, 400);
}

function safeName(title, fallback) {
  const base = String(title || fallback || '笔记')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return base || '笔记';
}

/**
 * @param {{dir:string, dataFile:string, log?:object, maxPerDay?:number, enabled?:boolean}} opts
 */
function createKnowledgeLearn({ dir, dataFile, log = null, maxPerDay = MAX_PER_DAY, enabled = true } = {}) {
  const outDir = path.join(dir, '学来的');
  let store = { version: 1, items: [] };

  function load() {
    try {
      store = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      if (!Array.isArray(store.items)) store.items = [];
    } catch {
      store = { version: 1, items: [] };
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(dataFile, JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {
      log?.warn?.(`知识自学：索引写盘失败 ${e.message}`);
    }
  }

  function todayCount() {
    const day = new Date().toISOString().slice(0, 10);
    return store.items.filter((it) => it.day === day).length;
  }

  /**
   * 看一句话，该学就学。
   * @param {{text:string, speaker?:string, fromOwner?:boolean, isGroup?:boolean, at?:number}} msg
   * @returns {{learned:boolean, reason?:string, file?:string, body?:string}}
   */
  function observe({ text, speaker = '', fromOwner = false, isGroup = false, at = Date.now() } = {}) {
    if (!enabled) return { learned: false, reason: 'disabled' };
    if (!fromOwner) return { learned: false, reason: 'not-owner' };

    const t = String(text || '').trim();
    if (!t || t.length < MIN_LEN) return { learned: false, reason: 'too-short' };

    const parsed = parseTeach(t) || parseCorrection(t);
    if (!parsed) return { learned: false, reason: 'not-teaching' };
    if (parsed.body.length < (parsed.kind === 'correction' ? 2 : MIN_LEN)) return { learned: false, reason: 'body-too-short' };

    const body = parsed.body.slice(0, MAX_LEN);
    const key = normBody(body);
    const dup = store.items.find((it) => it.key === key);
    if (dup) return { learned: false, reason: 'duplicate', file: dup.file };
    if (todayCount() >= maxPerDay) return { learned: false, reason: 'daily-limit' };

    const title = safeName(parsed.title, body.slice(0, 12));
    const stamp = new Date(at).toISOString().slice(0, 10);
    const fileName = `${title}-${stamp}.md`.replace(/\s+/g, '_');
    const file = path.join(outDir, fileName);
    const content = [
      `# ${title}`,
      '',
      body,
      '',
      `> 自学于 ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}` +
        `${speaker ? ` · 来源 ${speaker}` : ''}${isGroup ? ' · 群聊' : ' · 私聊'}`,
      '',
    ].join('\n');

    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    } catch (e) {
      log?.warn?.(`知识自学：写文件失败 ${e.message}`);
      return { learned: false, reason: 'io-error' };
    }

    store.items.push({
      key,
      title,
      body,
      file,
      speaker,
      fromOwner: true,
      isGroup: !!isGroup,
      at,
      day: new Date(at).toISOString().slice(0, 10),
    });
    if (store.items.length > 2000) store.items = store.items.slice(-2000);
    save();
    log?.info?.(`知识自学：记下「${title}」（${body.slice(0, 24)}…）`);
    return { learned: true, file, body, title };
  }

  /** 「忘掉刚才学的」 → 删最后一条 */
  function forgetLast() {
    if (!store.items.length) return null;
    const last = store.items.pop();
    try {
      if (last.file && fs.existsSync(last.file)) fs.unlinkSync(last.file);
    } catch (e) {
      log?.warn?.(`知识自学：删文件失败 ${e.message}`);
    }
    save();
    return last;
  }

  function stats() {
    return { total: store.items.length, today: todayCount() };
  }

  load();
  return { observe, forgetLast, stats, get enabled() { return enabled; }, outDir };
}

module.exports = {
  createKnowledgeLearn,
  parseTeach,
  parseCorrection,
  normBody,
  safeName,
};
