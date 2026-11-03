'use strict';
/**
 * 表情包（富媒体图片）。
 *
 * 官方限制：富媒体上传只接受**公网可访问的图片 URL**（本机文件传不上去，
 * 实测 multipart 会报 40093007「富媒体文件下载失败」）。所以这里的表情是
 * 「名字 + 标签 + 公网 URL」的目录，默认带一套 Noto 动态表情（GIF），
 * 想换成自己的表情包，往根目录的 stickers.json 里加一条就行。
 */

const fs = require('fs');
const path = require('path');

const STICKER_DEFAULTS = {
  enabled: true,
  minGapMs: 30000,       // 同一个聊天里两次表情的最小间隔（30 秒），防止刷屏
  catalogFile: 'stickers.json',
  folder: '表情包',       // 根目录下存表情包的文件夹（往里面丢图，文件名就是表情名）
  learn: {               // 别人发的图自动存下来（详见 sticker-learn.js）
    enabled: true,
    maxBytes: 4 * 1024 * 1024,
    maxCount: 80,
    maxPerMessage: 2,
  },
};

const NOTO = (code, ext = 'gif') => `https://fonts.gstatic.com/s/e/notoemoji/latest/${code}/512.${ext}`;

/** 默认表情目录：name 是模型要写的名字，tags 用来给自己表情配上心情 */
const DEFAULT_STICKERS = [
  { name: '笑死', tags: ['笑', '哈哈', '好笑', '乐', '绷不住'], url: NOTO('1f602') },
  { name: '绷不住', tags: ['笑', '乐', '离谱', '服了'], url: NOTO('1f923') },
  { name: '无语', tags: ['无语', '沉默', '尬', '服'], url: NOTO('1f611') },
  { name: '哭', tags: ['哭', '难受', '委屈', 'emo'], url: NOTO('1f62d') },
  { name: '困', tags: ['困', '睡', '晚安', '熬夜'], url: NOTO('1f634') },
  { name: '生气', tags: ['生气', '气', '烦', '火大'], url: NOTO('1f624') },
  { name: '得意', tags: ['得意', '坏笑', '自恋', '爽'], url: NOTO('1f60f') },
  { name: '思考', tags: ['思考', '想', '疑问', '问号'], url: NOTO('1f914') },
  { name: '赞', tags: ['赞', '行', '好', '牛逼'], url: NOTO('1f44d') },
  { name: '震惊', tags: ['震惊', '吓', '卧槽', '惊了'], url: NOTO('1f631') },
  { name: '尴尬', tags: ['尴尬', '汗', '呵呵', '社死'], url: NOTO('1f605') },
  { name: '累', tags: ['累', '疲惫', '没劲', '上班'], url: NOTO('1f629') },
  { name: '害羞', tags: ['害羞', '脸红', '不好意思'], url: NOTO('1f633') },
  { name: '好', tags: ['好', 'ok', '可以', '收到'], url: NOTO('1f44c') },
  { name: '没话说', tags: ['没话说', '闭嘴', '沉默'], url: NOTO('1f636') },
  { name: '哇', tags: ['哇', '惊讶', '厉害'], url: NOTO('1f62e', 'png') },
];

const MARKER_RE = /\[\[\s*(?:表情|sticker|贴纸)\s*[:：]\s*([^\]\n]{1,20}?)\s*\]\]/g;

function isHttpUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u.trim()); }

/**
 * 读取表情目录：默认表情 + 根目录 stickers.json 里用户自定义的（同名覆盖默认）。
 * stickers.json 格式：{ "stickers": [ { "name": "狗头", "tags": ["狗头","滑稽"], "url": "https://..." } ] }
 */
function loadStickers({ root, cfg, log } = {}) {
  const stickerCfg = { ...STICKER_DEFAULTS, ...((cfg && cfg.sticker) || {}) };
  const byName = new Map();
  for (const s of DEFAULT_STICKERS) byName.set(s.name, { ...s, tags: [...(s.tags || [])] });

  const file = path.join(root || process.cwd(), stickerCfg.catalogFile || 'stickers.json');
  let customCount = 0;
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw.stickers || []);
      for (const s of list) {
        if (!s || !s.name || (!isHttpUrl(s.url) && !s.file)) {
          log?.warn?.('stickers.json 里有一条没用（name 不对，或 url/file 都没写）:', JSON.stringify(s).slice(0, 120));
          continue;
        }
        const relFile = s.file ? String(s.file).trim() : undefined;
        byName.set(String(s.name).trim(), {
          name: String(s.name).trim(),
          tags: (Array.isArray(s.tags) ? s.tags : []).map(String),
          url: isHttpUrl(s.url) ? String(s.url).trim() : undefined,
          // 相对路径按项目根解析（这样打包到手机也能用同一份 stickers.json）
          file: relFile ? (path.isAbsolute(relFile) ? relFile : path.join(root || process.cwd(), relFile)) : undefined,
          pack: s.pack ? String(s.pack) : undefined,
        });
        customCount++;
      }
    }
  } catch (e) {
    log?.warn?.('读 stickers.json 失败，只用默认表情:', e.message);
  }

  // assets/stickers 里的本地图片：文件名就是表情名（笑死.png -> 笑死），自动收进目录。
  // 官方上传接口支持 file_data 直传（≤5MB），所以本地表情包也能发。
  try {
    const dir = path.join(root || process.cwd(), 'assets', 'stickers');
    if (fs.existsSync(dir)) {
      const local = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
      for (const f of local) {
        const name = path.basename(f, path.extname(f)).trim();
        if (!name || byName.has(name)) continue;
        byName.set(name, { name, tags: [], file: path.join(dir, f) });
        customCount++;
      }
      if (local.length) log?.info?.(`assets/stickers 里有 ${local.length} 张本地表情，已加入表情库`);
    }
  } catch (e) {
    log?.warn?.('扫描 assets/stickers 失败:', e.message);
  }

  // 表情包/ 文件夹：用户自己丢进去的图（文件名即表情名）+ 从聊天里学来的（表情包/学来的/）
  try {
    const folder = path.join(root || process.cwd(), stickerCfg.folder || '表情包');
    if (fs.existsSync(folder)) {
      const files = fs.readdirSync(folder).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
      for (const f of files) {
        const name = path.basename(f, path.extname(f)).trim();
        if (!name || byName.has(name)) continue;
        byName.set(name, { name, tags: [], file: path.join(folder, f) });
        customCount++;
      }
      // 学来的：名字和标签记在 表情包/_index.json 里
      const learnedDir = path.join(folder, '学来的');
      const indexFile = path.join(folder, '_index.json');
      let meta = [];
      try {
        if (fs.existsSync(indexFile)) {
          const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
          meta = Array.isArray(raw) ? raw : (raw.items || []);
        }
      } catch (e) {
        log?.warn?.('读 表情包/_index.json 失败，学来的表情按文件名识别:', e.message);
      }
      const metaByFile = new Map();
      for (const it of meta) if (it && it.file) metaByFile.set(String(it.file).split(path.sep).join('/'), it);
      let learnedCount = 0;
      if (fs.existsSync(learnedDir)) {
        for (const f of fs.readdirSync(learnedDir).filter((x) => /\.(png|jpe?g|gif|webp)$/i.test(x))) {
          const base = path.basename(f, path.extname(f)).trim();
          const it = metaByFile.get(`学来的/${f}`) || metaByFile.get(`学来的\\${f}`);
          const name = (it && it.name) || base;
          if (byName.has(name)) continue;
          byName.set(name, { name, tags: (it && it.tags) || [], file: path.join(learnedDir, f), learned: true });
          customCount++;
          learnedCount++;
        }
      }
      if (files.length || learnedCount) {
        log?.info?.(`表情包文件夹里有 ${files.length} 张自己的 + ${learnedCount} 张学来的`);
      }
    }
  } catch (e) {
    log?.warn?.('扫描 表情包 文件夹失败:', e.message);
  }

  // 目录顺序决定提示词里先列谁（catalogForPrompt 只取前 24 个）：
  // 自己配置 / 学来的 / 导入的图包优先，内置的网络表情排后面。
  const list = [...byName.values()];
  list.sort((a, b) => (b.file || b.learned ? 1 : 0) - (a.file || a.learned ? 1 : 0));
  return { list, config: stickerCfg, customCount };
}

/** 按名字找（先精确匹配 name，再匹配 tags） */
function pickSticker(list, name) {
  const want = String(name || '').trim();
  if (!want) return null;
  const arr = list || [];
  const exact = arr.find((s) => s.name === want);
  if (exact) return exact;
  const lower = want.toLowerCase();
  return arr.find((s) => (s.tags || []).some((t) => String(t).toLowerCase() === lower)) || null;
}

/**
 * 从模型回复里抽出 [[表情:名字]] 标记。
 * 返回 { text: 去掉标记后的文字, sticker: 命中的表情或 null, requested: 模型写的名字 }
 */
function extractSticker(text, list) {
  const src = String(text || '');
  let requested = null;
  let sticker = null;
  // 标记抠掉之后，原本挨着它的文字会被挤到一起（「行吧[[表情:睡觉]]明天见」→「行吧明天见」），
  // 所以先看它夹在两个句子中间：前面没标点、后面还有内容 -> 补一个「，」，别把断句吃掉
  const clean = src.replace(MARKER_RE, (_m, name, offset) => {
    if (!requested) requested = name;
    if (!sticker) sticker = pickSticker(list, name);
    const before = src.slice(0, offset);
    const after = src.slice(offset + _m.length);
    const needComma = /[^\s，。！？、；：,.!?…]$/.test(before) && /^\S/.test(after.trim());
    return needComma ? '，' : '';
  });
  return { text: clean.replace(/[ \t]+\n/g, '\n').replace(/，{2,}/g, '，').replace(/[，,、]+\s*$/, '').trim(), sticker, requested };
}

/** 把标记从文字里抠掉（写记忆时用，免得历史里全是 [[表情:xx]]） */
function stripStickerMarkers(text) {
  return String(text || '').replace(MARKER_RE, '').replace(/[ \t]+\n/g, '\n').trim();
}

/** 给 system prompt 用的目录说明 */
function catalogForPrompt(list, { max = 24 } = {}) {
  return (list || []).slice(0, max)
    .map((s) => `${s.name}（${(s.tags || []).slice(0, 3).join('/')}）`)
    .join('、');
}

/**
 * 发表情：先上传拿 file_info（缓存 24h），再发一条 msg_type=7 的图片消息。
 * 上传是「按图片 URL」缓存的：同一张图只上传一次。
 */
function createStickerService({ bot, log, cachePath = null, now = Date.now, minGapMs } = {}) {
  const gap = minGapMs == null ? STICKER_DEFAULTS.minGapMs : minGapMs;
  const fileCache = new Map();   // `${scene}:${url}` -> { fileInfo, exp }
  const lastSentAt = new Map();  // 会话 key -> 时间戳

  if (cachePath) {
    try {
      if (fs.existsSync(cachePath)) {
        const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (const [k, v] of Object.entries(raw || {})) {
          if (v && v.fileInfo && v.exp > now()) fileCache.set(k, v);
        }
      }
    } catch { /* 缓存坏了就当没有 */ }
  }

  function persist() {
    if (!cachePath) return;
    try {
      const obj = {};
      for (const [k, v] of fileCache) if (v.exp > now()) obj[k] = v;
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
      fs.renameSync(tmp, cachePath);
    } catch (e) { log?.debug?.('写表情缓存失败:', e.message); }
  }

  function targetPath(msg) {
    return msg.scene === 'c2c'
      ? `/v2/users/${encodeURIComponent(msg.userId)}/files`
      : `/v2/groups/${encodeURIComponent(msg.groupId)}/files`;
  }

  function messagePath(msg) {
    return msg.scene === 'c2c'
      ? `/v2/users/${encodeURIComponent(msg.userId)}/messages`
      : `/v2/groups/${encodeURIComponent(msg.groupId)}/messages`;
  }

  const MAX_FILE_BYTES = 5 * 1024 * 1024;   // 官方 file_data 直传上限 5M

  /** 缓存 key：远程图按 URL，本地图按「路径 + 修改时间 + 大小」，换图会自动重传 */
  function cacheKey(scene, sticker) {
    if (sticker.file) {
      try {
        const st = fs.statSync(sticker.file);
        return `${scene}:file:${sticker.file}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${scene}:file:${sticker.file}:missing`;
      }
    }
    return `${scene}:url:${sticker.url}`;
  }

  async function upload(msg, sticker, { force = false } = {}) {
    const key = cacheKey(msg.scene, sticker);
    const hit = fileCache.get(key);
    if (!force && hit && hit.exp > now()) return hit.fileInfo;

    let body;
    if (sticker.file) {
      // 本地图片：读成 base64 直传（官方 file_data，≤5M）
      let buf;
      try { buf = fs.readFileSync(sticker.file); }
      catch (e) { throw new Error(`读本地表情失败：${sticker.file}（${e.message}）`); }
      if (buf.length > MAX_FILE_BYTES) {
        const err = new Error(`本地表情太大（${(buf.length / 1048576).toFixed(1)}M > 5M）：${path.basename(sticker.file)}`);
        err.errCode = 850031;
        throw err;
      }
      body = {
        file_type: 1,
        file_name: path.basename(sticker.file),
        file_data: buf.toString('base64'),
        srv_send_msg: false,
      };
    } else {
      body = { file_type: 1, url: sticker.url, srv_send_msg: false };
    }

    const data = await bot.api('POST', targetPath(msg), body);
    if (!data || !data.file_info) throw new Error('上传图片没拿到 file_info: ' + JSON.stringify(data).slice(0, 200));
    const ttl = Number(data.ttl) > 0 ? Number(data.ttl) : 3600;   // 0 = 长期可用，按 1 小时保守缓存
    fileCache.set(key, { fileInfo: data.file_info, exp: now() + (ttl - 120) * 1000 });
    persist();
    return data.file_info;
  }

  /** 冷却：同一个对话里两次表情至少隔 minGapMs */
  function canSend(key) {
    if (!(gap > 0)) return true;
    const last = lastSentAt.get(key) || 0;
    return now() - last >= gap;
  }

  function markSent(key) { lastSentAt.set(key, now()); }

  /**
   * 发一个表情。passive + msgId 时算被动回复（占一次额度）。
   * 返回 { ok, fileInfo } —— 失败只记日志，不抛给调用方，聊天不能被表情搞挂。
   */
  async function send(msg, sticker, seq = 1, { passive = true } = {}) {
    if (!sticker) return { ok: false, reason: 'no-sticker' };
    for (let attempt = 0; attempt < 2; attempt++) {
      let fileInfo;
      try {
        fileInfo = await upload(msg, sticker, { force: attempt > 0 });
      } catch (e) {
        log?.warn?.('表情上传失败:', sticker.name, e.errCode || '', e.message);
        return { ok: false, reason: 'upload-failed', errCode: e.errCode };
      }
      const body = { msg_type: 7, media: { file_info: fileInfo }, msg_seq: seq };
      if (passive && msg.msgId) body.msg_id = msg.msgId;
      try {
        await bot.api('POST', messagePath(msg), body);
        lastSentAt.set(sessionKey(msg), now());
        return { ok: true, fileInfo };
      } catch (e) {
        log?.warn?.('表情发送失败:', sticker.name, e.errCode || '', e.message);
        if (e.errCode === 40054005) return { ok: true, deduped: true };   // 已经发过了
        // file_info 过期/不属于这个会话：清缓存重传一次
        const cacheable = [40093001, 40093002, 40093003, 40093004, 40093007, 304080];
        fileCache.delete(cacheKey(msg.scene, sticker));
        persist();
        if (!cacheable.includes(e.errCode) && e.errCode !== 40034005) return { ok: false, reason: 'send-failed', errCode: e.errCode };
      }
    }
    return { ok: false, reason: 'send-failed' };
  }

  function sessionKey(msg) { return `${msg.scene}:${msg.userId || msg.groupId}`; }

  return { send, upload, canSend, markSent, sessionKey, _cache: fileCache };
}

module.exports = {
  STICKER_DEFAULTS, DEFAULT_STICKERS,
  loadStickers, pickSticker, extractSticker, stripStickerMarkers, catalogForPrompt, createStickerService,
};
