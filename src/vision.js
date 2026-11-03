'use strict';
/**
 * 看图：把 QQ 消息里的图片下载下来，转成模型能吃的 data URI。
 *
 * 为什么能这么干：DeepSeek 的 chat/completions 支持 image_url 内容块（实测 deepseek-flash 能看懂图），
 * 而 QQ 的 attachments[].url 是能直接 GET 的 CDN 地址（「学别人发的表情包」那条链路早就验证过）。
 *
 * 注意：只有**关掉思考链**时它才好好描述图（开着思考链 token 全被 reasoning 吃光、正文是空字符串）。
 * 这一点本项目的 brain 已经默认关掉了。
 */
const crypto = require('crypto');

const VISION_DEFAULTS = {
  enabled: true,
  maxImages: 2,                 // 一次最多看几张（多了烧 token，也容易把小字看漏）
  maxBytes: 5 * 1024 * 1024,    // 单张上限，超了就跳过
  timeoutMs: 15000,
  cacheMinutes: 10,             // 同一张图 10 分钟内不重复下载
  privateOnly: false,           // true = 群里一律不看图
  groupOnlyWhenCalled: true,    // 群里只有 @ 它/叫它名字时才看
};

const TYPE_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** 从 content_type / URL 里猜出图片格式（模型只认 png/jpeg/gif/webp） */
function guessMime(contentType, url) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (TYPE_TO_EXT[ct]) return ct === 'image/jpg' ? 'image/jpeg' : ct;
  const m = String(url || '').match(/\.(png|jpe?g|gif|webp)(?:$|[?#])/i);
  if (m) {
    const ext = m[1].toLowerCase();
    return ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  }
  return 'image/jpeg';
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/**
 * @param {object} o
 * @param {object} o.cfg    qq.vision 配置
 * @param {function} [o.fetchImpl]
 * @param {function} [o.now]
 */
function createImageLoader({ cfg = {}, log = null, fetchImpl = null, now = Date.now, timer = null } = {}) {
  const opts = { ...VISION_DEFAULTS, ...cfg };
  const cache = new Map(); // url -> { at, item }
  const pending = new Map(); // url -> Promise（同一张图并发只下一次）

  function cacheGet(url) {
    const hit = cache.get(url);
    if (!hit) return null;
    if (now() - hit.at > (opts.cacheMinutes || 0) * 60000) {
      cache.delete(url);
      return null;
    }
    return hit.item;
  }

  function cachePut(url, item) {
    cache.set(url, { at: now(), item });
    if (cache.size > 40) {
      // 简单的 FIFO 清理，别让 Map 无限长
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    return item;
  }

  async function fetchOne(img) {
    const url = String(img?.url || '');
    if (!url) return { error: 'no-url' };
    const cached = cacheGet(url);
    if (cached) return cached;
    if (img.size && Number(img.size) > opts.maxBytes) return { error: 'too-large' };

    const f = fetchImpl || globalThis.fetch;
    const ctrl = new AbortController();
    const ms = opts.timeoutMs || 15000;
    const killer = setTimeout(() => ctrl.abort(), ms);
    if (timer && typeof ctrl.signal.unref !== 'undefined') {
      /* noop */
    }
    try {
      const res = await f(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) return { error: 'http-' + res.status };
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { error: 'empty' };
      if (buf.length > opts.maxBytes) return { error: 'too-large' };
      const head = buf.subarray(0, 12);
      const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
      const isJpg = head[0] === 0xff && head[1] === 0xd8;
      const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46;
      const isWebp = buf.length > 12 && head.toString('latin1').includes('WEBP');
      if (!isPng && !isJpg && !isGif && !isWebp) return { error: 'not-image' };

      const mime = isPng ? 'image/png' : isJpg ? 'image/jpeg' : isGif ? 'image/gif' : 'image/webp';
      const item = {
        mime,
        bytes: buf.length,
        sha1: sha1(buf),
        dataUri: `data:${mime};base64,${buf.toString('base64')}`,
        filename: img.filename || '',
      };
      return cachePut(url, item);
    } catch (e) {
      return { error: e?.name === 'AbortError' ? 'timeout' : 'fetch-failed' };
    } finally {
      clearTimeout(killer);
    }
  }

  /**
   * 一批图 → 能塞给模型的 data URI 列表
   * @returns {Promise<{items: Array<{dataUri,mime,bytes,sha1}>, errors: string[], skipped: string|null}>}
   */
  async function load(images = [], { isGroup = false, mentioned = false } = {}) {
    if (opts.enabled === false) return { items: [], errors: [], skipped: 'vision-off' };
    if (isGroup && opts.privateOnly === true) return { items: [], errors: [], skipped: 'vision-private-only' };
    if (isGroup && opts.groupOnlyWhenCalled !== false && !mentioned) {
      return { items: [], errors: [], skipped: 'vision-not-called' };
    }
    const list = (Array.isArray(images) ? images : []).filter((i) => i && i.url).slice(0, opts.maxImages || 2);
    if (!list.length) return { items: [], errors: [], skipped: null };

    const items = [];
    const errors = [];
    for (const img of list) {
      let p = pending.get(img.url);
      if (!p) {
        p = fetchOne(img).finally(() => pending.delete(img.url));
        pending.set(img.url, p);
      }
      const r = await p;
      if (r && r.error) {
        errors.push(r.error);
        log?.debug?.('看图：这张没收下', r.error, String(img.url).slice(0, 60));
      } else if (r) {
        items.push(r);
      }
    }
    log?.debug?.(`看图：${items.length} 张可用${errors.length ? `（${errors.join(',')} 张失败）` : ''}`);
    return { items, errors, skipped: items.length ? null : 'vision-unavailable' };
  }

  return { load, settings: opts, guessMime, clearCache: () => cache.clear() };
}

module.exports = { VISION_DEFAULTS, createImageLoader, guessMime };
