'use strict';
/**
 * 「学表情包」：别人在 QQ 里发的图，自动存进 表情包/学来的/ ，并加进表情库。
 *
 * 为什么这么做：官方没有「收藏表情」接口，能发的只有图片消息；
 * 所以要让机器人「学会用别人发过的表情」，只能把图存到本地，
 * 再用 file_data 直传发出去（本地图 ≤5M 可以直传，实测可行）。
 *
 * 目录结构（都可以用 config.json 的 sticker 块改）：
 *   表情包/                  <- 你自己往这里丢图，文件名就是表情名（直接可用）
 *     学来的/                <- 从聊天里学到的图（自动命名「学来的1」「学来的2」…）
 *     _index.json            <- 学来的那些图的标签、来源、时间去重记录
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEARN_DEFAULTS = {
  enabled: true,
  folder: '表情包',          // 根目录下存表情包的文件夹
  learnedSubdir: '学来的',    // 学到的图放这里
  maxBytes: 4 * 1024 * 1024,  // 太大的不学（超过 5M 也发不出去）
  maxCount: 80,               // 最多攒这么多张，超了删最老的
  maxPerMessage: 2,           // 一条消息里最多学两张
  timeoutMs: 20000,
};

/** 看文件头判断图片格式（QQ 给的 content_type 不一定可信） */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** 从消息文字里提炼标签（「哈哈哈」这种当情绪标签，给模型挑表情用） */
function tagsFromText(text) {
  const t = String(text || '').replace(/\[表情\]|\[图片\]/g, '').trim();
  if (!t) return [];
  const cleaned = t.replace(/[\s。，,.!?！？~～…、;；:：()（）]/g, '');
  if (!cleaned) return [];
  const tags = [];
  if (cleaned.length <= 12) tags.push(cleaned);
  else tags.push(cleaned.slice(0, 12));
  return tags;
}

/**
 * 创建学习器。list 是共享的表情目录数组（直接在原地 push，
 * 大脑和 responder 拿的是同一个引用，所以加进去立刻能用）。
 */
function createStickerLearner({ root, cfg, list, log, fetchImpl, now = Date.now } = {}) {
  const stickerCfg = (cfg && cfg.sticker) || {};
  const settings = { ...LEARN_DEFAULTS, ...(stickerCfg.learn || {}) };
  const baseDir = root || process.cwd();
  const folderName = settings.folder || stickerCfg.folder || LEARN_DEFAULTS.folder;
  const folderDir = path.join(baseDir, folderName);
  const learnedDir = path.join(folderDir, settings.learnedSubdir || LEARN_DEFAULTS.learnedSubdir);
  const indexFile = path.join(folderDir, '_index.json');

  let items = [];      // [{ name, file(相对 folderDir), tags, sha1, at, source }]
  let seqMax = 0;
  const bySha = new Map();

  function rel(p) { return path.relative(folderDir, p).split(path.sep).join('/'); }

  function load() {
    try {
      if (!fs.existsSync(indexFile)) return;
      const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.items || []);
      items = [];
      bySha.clear();
      for (const it of arr) {
        if (!it || !it.file) continue;
        const abs = path.join(folderDir, it.file);
        if (!fs.existsSync(abs)) continue;      // 文件被删了就不再算数
        const name = String(it.name || path.basename(it.file, path.extname(it.file)));
        items.push({
          name,
          file: it.file,
          tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
          sha1: it.sha1 || null,
          at: Number(it.at) || 0,
          source: it.source || null,
        });
        if (it.sha1) bySha.set(it.sha1, items[items.length - 1]);
        const m = /^学来的(\d+)$/.exec(name);
        if (m) seqMax = Math.max(seqMax, Number(m[1]));
      }
    } catch (e) {
      log?.warn?.('读表情索引失败，重新开始攒:', e.message);
      items = [];
      bySha.clear();
    }
  }

  function save() {
    try {
      fs.mkdirSync(folderDir, { recursive: true });
      const tmp = `${indexFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: now(), items }, null, 2), 'utf8');
      fs.renameSync(tmp, indexFile);
    } catch (e) { log?.warn?.('写表情索引失败:', e.message); }
  }

  /** 把一条学到的表情塞进共享目录（大脑立刻能在提示词里看到它） */
  function register(item) {
    const abs = path.join(folderDir, item.file);
    if (!Array.isArray(list)) return;
    if (list.some((s) => s.file === abs || s.name === item.name)) return;
    list.push({ name: item.name, tags: item.tags.slice(), file: abs, learned: true });
  }

  function unregister(item) {
    if (!Array.isArray(list)) return;
    const abs = path.join(folderDir, item.file);
    const i = list.findIndex((s) => s.file === abs);
    if (i >= 0) list.splice(i, 1);
  }

  function evictIfNeeded() {
    while (items.length >= (settings.maxCount || LEARN_DEFAULTS.maxCount)) {
      // 最老的先删
      items.sort((a, b) => a.at - b.at);
      const old = items.shift();
      if (!old) break;
      unregister(old);
      if (old.sha1) bySha.delete(old.sha1);
      try { fs.rmSync(path.join(folderDir, old.file), { force: true }); } catch { /* 删不掉就算了 */ }
      log?.info?.('表情库满了，删掉最老的一个:', old.name);
    }
  }

  function names() { return items.map((it) => it.name); }

  /** 处理一个附件（QQ 消息里的 attachments 元素） */
  async function learnImage(att, { text = '', source = null } = {}) {
    if (!settings.enabled) return { skipped: 'learn-off' };
    if (!att || !att.url) return { skipped: 'no-url' };
    const ct = String(att.content_type || '');
    if (ct && !/^image\//i.test(ct)) return { skipped: 'not-image' };
    const declared = Number(att.size) || 0;
    if (declared && declared > settings.maxBytes) return { skipped: 'too-big' };

    const doFetch = fetchImpl || globalThis.fetch;
    if (!doFetch) return { skipped: 'no-fetch' };

    let buf;
    try {
      const res = await doFetch(att.url, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(settings.timeoutMs) : undefined,
      });
      if (!res || !res.ok) return { skipped: 'download-failed', status: res && res.status };
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      log?.debug?.('下载表情失败:', e.message);
      return { skipped: 'download-error', error: e.message };
    }

    if (!buf || !buf.length) return { skipped: 'empty' };
    if (buf.length > settings.maxBytes) return { skipped: 'too-big' };
    const ext = sniffImage(buf);
    if (!ext) return { skipped: 'not-image' };

    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    const dup = bySha.get(sha1);
    if (dup) return { duplicate: true, name: dup.name };

    seqMax += 1;
    const name = `学来的${seqMax}`;
    const relFile = path.join(settings.learnedSubdir || LEARN_DEFAULTS.learnedSubdir, `${name}.${ext}`);
    const absFile = path.join(folderDir, relFile);
    try {
      fs.mkdirSync(path.dirname(absFile), { recursive: true });
      fs.writeFileSync(absFile, buf);
    } catch (e) {
      log?.warn?.('存表情失败:', e.message);
      return { skipped: 'write-error', error: e.message };
    }

    evictIfNeeded();
    const item = {
      name,
      file: rel(absFile),
      tags: tagsFromText(text),
      sha1,
      at: now(),
      source: source || null,
    };
    items.push(item);
    bySha.set(sha1, item);
    register(item);
    save();
    log?.info?.(`学会一个新表情：${name}${item.tags.length ? `（标签：${item.tags.join('/')}）` : ''}`);
    return { learned: true, name };
  }

  /** 一条消息里可能带多个图；最多学 maxPerMessage 个 */
  async function learnFromMessage(msg, { text = '', source = null } = {}) {
    const list2 = (msg && msg.attachments) || [];
    const results = [];
    const batch = list2.slice(0, settings.maxPerMessage || LEARN_DEFAULTS.maxPerMessage);
    for (const att of batch) {
      try {
        const r = await learnImage(att, { text, source });
        if (r && (r.learned || r.duplicate)) results.push(r);
      } catch (e) {
        log?.debug?.('学表情出错:', e.message);
      }
    }
    return { results, names: results.filter((r) => r.learned).map((r) => r.name) };
  }

  load();
  if (items.length) log?.info?.(`表情库里已有 ${items.length} 个学来的表情`);

  return { settings, folderDir, learnedDir, indexFile, learnImage, learnFromMessage, names, items: () => items.slice(), _reload: load };
}

module.exports = { LEARN_DEFAULTS, sniffImage, tagsFromText, createStickerLearner };
