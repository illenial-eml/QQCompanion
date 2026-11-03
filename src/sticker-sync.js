'use strict';
/**
 * 把小号 QQ「收藏的表情」（自己加的贴纸/表情包）同步成本地表情库。
 *
 * 原理：NapCat 提供了 `fetch_custom_face`（收藏表情列表）和
 * `fetch_custom_face_detail`。我们拿列表里的 URL，把图下载到
 * `表情包/学来的/`，再把条目追加进根目录 `stickers.json`（带 file 路径），
 * 现有的 loadStickers() 就会自动把它们算进表情库，模型按名字/标签挑着发。
 *
 * 全程容错：拿不到列表、某张下载失败，都只记日志，不影响聊天。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024; // 单张表情上限 5MB

/** NapCat 的收藏表情返回结构各家版本不一，这里做兜底 */
function normalizeFaceList(payload) {
  const raw = payload && (payload.data ?? payload);
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.list)
      ? raw.list
      : Array.isArray(raw?.data)
        ? raw.data
        : [];
  const out = [];
  for (const it of arr) {
    if (!it) continue;
    const url = String(it.url || it.fileUrl || it.thumbUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const id = String(it.resId || it.res_id || it.emojiId || it.id || url);
    const desc = String(it.desc || it.name || it.summary || '').trim();
    out.push({ id, url, desc });
  }
  // 同一个 id 只留一条
  const seen = new Set();
  return out.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}

function safeName(s, fallback) {
  const base = String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return base || fallback;
}

function guessExt(url) {
  const m = String(url || '').match(/\.(png|jpe?g|gif|webp|bmp)(?:\?|$)/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'gif';
}

/** 默认下载器：支持重定向、限大小 */
function httpDownload(url, { maxBytes = MAX_BYTES, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      if (hops > 4) return reject(new Error('重定向太多'));
      const mod = /^https:/i.test(u) ? https : http;
      const req = mod.get(u, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, u).toString(), hops + 1);
        }
        if (code !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${code}`));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new Error('图片太大'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('下载超时')));
    };
    go(url, 0);
  });
}

/**
 * @param {{client:object, root:string, cfg?:object, log?:object, download?:Function}} opts
 */
function createStickerSync({ client, root, cfg = {}, log = null, download = httpDownload } = {}) {
  const folder = path.join(root, cfg.sticker?.folder || '表情包', '学来的');
  const dataDir = cfg.paths?.data
    ? (path.isAbsolute(cfg.paths.data) ? cfg.paths.data : path.join(root, cfg.paths.data))
    : path.join(root, 'data');
  const manifestFile = path.join(dataDir, 'custom-faces.json');
  const catalogFile = path.join(root, cfg.sticker?.catalogFile || 'stickers.json');
  const maxCount = Number(cfg.stickerSync?.maxCount ?? 200);

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  }

  /** 拉列表 → 下载新图 → 登记到 stickers.json */
  async function sync() {
    let faces;
    try {
      const res = await client.api('fetch_custom_face', {});
      faces = normalizeFaceList(res);
    } catch (e) {
      log?.warn?.(`同步表情包：拿收藏列表失败（不影响聊天）${e.message}`);
      return { added: 0, total: 0, error: e.message };
    }
    if (!faces.length) {
      log?.info?.('同步表情包：收藏里没有可用图片');
      return { added: 0, total: 0 };
    }

    const manifest = readJson(manifestFile, { version: 1, items: [] });
    if (!Array.isArray(manifest.items)) manifest.items = [];
    const known = new Set(manifest.items.map((it) => it.id));

    const catalog = readJson(catalogFile, { stickers: [] });
    const catList = Array.isArray(catalog) ? catalog : catalog.stickers || [];
    const existingFiles = new Set(catList.map((s) => String(s.file || '')).filter(Boolean));

    fs.mkdirSync(folder, { recursive: true });
    let added = 0;
    for (const face of faces) {
      if (known.has(face.id)) continue;
      if (manifest.items.length >= maxCount) break;
      const hash = crypto.createHash('sha1').update(face.id).digest('hex').slice(0, 8);
      const ext = guessExt(face.url);
      const name = safeName(face.desc, `表情${hash.slice(0, 4)}`);
      const fileName = `${name}-${hash}.${ext}`;
      const absFile = path.join(folder, fileName);
      const relFile = path.relative(root, absFile).split(path.sep).join('/');
      try {
        const buf = await download(face.url, { maxBytes: MAX_BYTES });
        if (!buf || !buf.length) throw new Error('空文件');
        fs.writeFileSync(absFile, buf);
      } catch (e) {
        log?.warn?.(`同步表情包：下载失败「${name}」${e.message}`);
        continue;
      }
      manifest.items.push({ id: face.id, name, file: relFile, url: face.url, at: Date.now() });
      if (!existingFiles.has(relFile)) {
        catList.push({ name, file: relFile, tags: [], pack: 'custom-face' });
        existingFiles.add(relFile);
        added++;
      }
      log?.info?.(`同步表情包：学会「${name}」（${Math.round(fs.statSync(absFile).size / 1024)}KB）`);
    }

    manifest.updatedAt = Date.now();
    writeJson(manifestFile, manifest);
    writeJson(catalogFile, Array.isArray(catalog) ? catList : { ...catalog, stickers: catList });
    log?.info?.(`同步表情包：收藏 ${faces.length} 张，本次新增 ${added} 张，库内共 ${manifest.items.length} 张`);
    return { added, total: manifest.items.length, fetched: faces.length };
  }

  return { sync, folder, catalogFile, manifestFile, normalizeFaceList };
}

module.exports = { createStickerSync, normalizeFaceList, guessExt, safeName };
