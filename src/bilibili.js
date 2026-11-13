'use strict';
/**
 * 让她自己刷 B 站。
 *
 * 不是在聊天里替用户搜视频，而是「她自己有空时会去 B 站逛一圈」：
 *   热门列表 / 按她感兴趣的关键词搜 → 挑一个没看过的 → 读简介、标签、几条热门评论
 *   → 用她自己的语气写一两句真实反应（好奇/吐槽/想试试）→ 存下来。
 *
 * 存 data/bili.json：
 *   { watched: [{ bvid, aid, title, up, desc, tags[], comments[], her, at, url }],
 *     seen: [bvid...], lastAt, day, dayCount, cursor }
 *
 * 只用于给私聊提供谈资：注入时一段「## 你刚刷到的」，不主动发消息。
 * 关掉：config.json → bili.enabled=false
 */

const fs = require('fs');
const path = require('path');

const BILI_DEFAULTS = {
  enabled: true,
  file: 'data/bili.json',
  interests: ['猫', '游戏', '音乐', '做饭', '宇宙'],
  maxPerDay: 4,
  minGapMinutes: 90,
  quietHours: [1, 7], // 这个时间段不刷
  timeoutMs: 9000,
  hotMix: 0.5, // 一半看热门、一半按兴趣搜
  commentCount: 3,
  descChars: 320,
  injectCount: 3,
  injectChars: 380,
  maxWatched: 200,
  reactionMaxTokens: 80,
  // 记住喜欢的UP主：刷完让她自己判断喜不喜欢，喜欢就记下来，以后优先刷
  judgeLike: true,
  preferLikedUp: 0.5,
  judgeMaxTokens: 60,
  maxUps: 40,
  // 主动分享：每天最多 3 条、间隔 3 小时、22 点到 9 点不发
  sharePerDay: 3,
  shareMinGapMinutes: 180,
  shareQuietHours: [22, 9],
  shareWithinHours: 6,
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REACTION_SYSTEM = [
  '你刚在 B 站随手刷到一个视频，现在看完/看了一半。',
  '用你自己的语气说一两句真实反应（不超过 40 字）：可以是好奇、吐槽、想试试、有点感动、想起别的事。',
  '规矩：',
  '- 别总结视频讲了什么，别客观点评，别说「这个视频」四个字开头。',
  '- 像随口跟人说的，可以带语气词；不用句号收尾也正常。',
  '- 不要 emoji（最多一个），不要列点，不要反问。',
  '- 只输出这一两句，不要引号。',
].join('\n');

function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 200);
}

function dayKeyOf(nowMs, tzOffsetHours = 8) {
  const d = new Date(nowMs + tzOffsetHours * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function hourOf(nowMs, tzOffsetHours = 8) {
  const d = new Date(nowMs + tzOffsetHours * 3600 * 1000);
  return d.getUTCHours();
}

function inQuietHours(hour, range) {
  const [a, b] = Array.isArray(range) ? range : [1, 7];
  if (a === b) return false;
  if (a < b) return hour >= a && hour < b;
  return hour >= a || hour < b;
}

function videoUrl(bvid) {
  return `https://www.bilibili.com/video/${bvid}`;
}

/** 把时长秒数说成人话（她念的时候不用精确到秒） */
function durText(sec) {
  const s = Number(sec) || 0;
  if (s <= 0) return '';
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} 小时 ${rm} 分钟` : `${h} 小时`;
}

function createBiliBrowser({ cfg = {}, log = null, now = () => Date.now(), fetchImpl = null, onBrowse = null } = {}) {
  const conf = { ...BILI_DEFAULTS, ...(cfg || {}) };
  const filePath = conf.file;
  const doFetch = fetchImpl || globalThis.fetch;
  let st = { watched: [], seen: [], lastAt: 0, day: '', dayCount: 0, cursor: 0, paused: false, ups: {}, shared: [], shareDay: '', shareCount: 0 };
  let lastMtime = 0;
  let cookie = '';
  let cookieAt = 0;

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw && typeof raw === 'object') st = { ...st, ...raw };
        lastMtime = fs.statSync(filePath).mtimeMs;
      }
    } catch (e) {
      log?.warn?.(`B站记录读取失败（用默认）: ${e.message}`);
    }
    if (!Array.isArray(st.watched)) st.watched = [];
    if (!Array.isArray(st.seen)) st.seen = [];
    if (!Array.isArray(st.shared)) st.shared = [];
    if (!st.ups || typeof st.ups !== 'object') st.ups = {};
  }

  /** 面板/命令改过 bili.json（比如暂停刷）时，重读一次，不用重启机器人 */
  function maybeReload() {
    try {
      if (!fs.existsSync(filePath)) return;
      const m = fs.statSync(filePath).mtimeMs;
      if (m !== lastMtime) load();
    } catch (e) {}
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(st, null, 2) + '\n', 'utf8');
      try { lastMtime = fs.statSync(filePath).mtimeMs; } catch (e) {}
    } catch (e) {
      log?.warn?.(`B站记录写入失败: ${e.message}`);
    }
  }

  function headers() {
    const h = {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    if (cookie) h.Cookie = cookie;
    return h;
  }

  /** B 站接口对没有 buvid 的请求会限流，先访问一次首页攒 cookie */
  async function warmUp() {
    if (cookie && now() - cookieAt < 6 * 3600 * 1000) return;
    try {
      const r = await doFetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(conf.timeoutMs) });
      const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      const c = list.map((x) => String(x).split(';')[0]).filter(Boolean).join('; ');
      if (c) {
        cookie = c;
        cookieAt = now();
      }
    } catch (e) {
      log?.debug?.(`B站 cookie 预热失败（继续裸跑）: ${e.message}`);
    }
  }

  async function api(url) {
    await warmUp();
    const r = await doFetch(url, { headers: headers(), signal: AbortSignal.timeout(conf.timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== 0) throw new Error(`B站接口 code ${j.code} ${j.message || ''}`.trim());
    return j.data;
  }

  /** 全站热门（不需要登录） */
  async function hotList(limit = 20) {
    const data = await api(`https://api.bilibili.com/x/web-interface/popular?ps=${Math.max(5, Math.min(50, limit))}&pn=1`);
    return (data && data.list) || [];
  }

  /** 按关键词搜（不签 wbi 也能用，B 站目前没挡） */
  async function searchList(keyword, limit = 10) {
    const kw = encodeURIComponent(String(keyword || '').trim());
    if (!kw) return [];
    const data = await api(
      `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${kw}&page=1`,
    );
    const list = (data && data.result) || [];
    return list.map((it) => ({
      bvid: it.bvid,
      aid: it.aid,
      title: clean(it.title, 120),
      author: it.author,
      play: it.play,
      duration: it.duration,
      description: clean(it.description, 200),
    }));
  }

  /** 视频详情：简介 + 标签 + 几条热门评论（够她「看过」了） */
  async function detail(bvid) {
    const d = await api(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    const out = {
      bvid,
      aid: d.aid,
      title: clean(d.title, 120),
      up: clean(d.owner && d.owner.name, 40),
      desc: clean(d.desc, conf.descChars),
      duration: d.duration,
      tags: [],
      comments: [],
      url: videoUrl(bvid),
    };
    try {
      const tags = await api(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`);
      out.tags = (Array.isArray(tags) ? tags : []).slice(0, 8).map((t) => clean(t.tag_name, 16)).filter(Boolean);
    } catch (e) {
      log?.debug?.(`B站标签取不到: ${e.message}`);
    }
    try {
      const cm = await api(`https://api.bilibili.com/x/v2/reply?type=1&oid=${out.aid}&sort=2&ps=${conf.commentCount}&pn=1`);
      const replies = (cm && cm.replies) || [];
      out.comments = replies.slice(0, conf.commentCount).map((r) => clean(r.content && r.content.message, 80)).filter(Boolean);
    } catch (e) {
      log?.debug?.(`B站评论取不到: ${e.message}`);
    }
    return out;
  }

  function todayCountNow() {
    const day = dayKeyOf(now());
    if (st.day !== day) {
      st.day = day;
      st.dayCount = 0;
      save();
    }
    return st.dayCount;
  }

  /** 现在该不该去刷（每日上限 + 最小间隔 + 深夜不刷） */
  function dueNow() {
    if (!conf.enabled) return { due: false, reason: 'off' };
    maybeReload();
    if (st.paused) return { due: false, reason: 'paused' };
    const h = hourOf(now());
    if (inQuietHours(h, conf.quietHours)) return { due: false, reason: 'quiet' };
    const count = todayCountNow();
    if (count >= (Number(conf.maxPerDay) || 4)) return { due: false, reason: 'day-limit' };
    const gap = Number(conf.minGapMinutes) * 60 * 1000 || 0;
    if (st.lastAt && now() - st.lastAt < gap) return { due: false, reason: 'gap' };
    return { due: true, reason: 'ok' };
  }

  /** 挑一个：优先她喜欢的UP主，其次热门 / 按兴趣关键词搜索；跳过看过的、太长的、广告味标题 */
  async function pick() {
    const seen = new Set(st.seen || []);
    const usable = (pool) =>
      (pool || []).filter((it) => {
        if (!it || !it.bvid || seen.has(it.bvid)) return false;
        const dur = Number(it.duration || 0);
        if (dur > 45 * 60) return false;
        if (/广告|带货|优惠券|加微信|私信领取/.test(it.title || '')) return false;
        return true;
      });

    // ① 优先：她喜欢的 UP 主（概率 preferLikedUp）
    const upNames = Object.keys(st.ups || {});
    if (upNames.length && Math.random() < Number(conf.preferLikedUp ?? 0.5)) {
      const name = upNames[Math.floor(Math.random() * upNames.length)];
      try {
        const list = await searchList(name, 10);
        const only = list.filter((it) => clean(it.author, 40) === name);
        const pool = usable(only.map((it) => ({ ...it, up: clean(it.author, 40), desc: it.description || '' })));
        if (pool.length) return { ...pool[Math.floor(Math.random() * pool.length)], keyword: 'UP:' + name };
      } catch (e) {
        log?.debug?.(`B站：搜喜欢的UP主「${name}」没成: ${e.message}`);
      }
    }

    // ② 热门 / ③ 兴趣关键词
    const useHot = Math.random() < Number(conf.hotMix ?? 0.5);
    let pool = [];
    let keyword = '';
    if (useHot) {
      pool = (await hotList(20)).map((it) => ({
        bvid: it.bvid,
        title: clean(it.title, 120),
        up: clean(it.owner && it.owner.name, 40),
        duration: it.duration,
        desc: clean(it.desc, 200),
      }));
    } else {
      const interests = Array.isArray(conf.interests) && conf.interests.length ? conf.interests : ['猫'];
      st.cursor = (Number(st.cursor) || 0) % interests.length;
      keyword = interests[st.cursor];
      st.cursor = (st.cursor + 1) % interests.length;
      const list = await searchList(keyword, 10);
      pool = list.map((it) => ({ ...it, up: clean(it.author, 40), desc: it.description || '' }));
    }
    const ok = usable(pool);
    if (!ok.length) return null;
    return { ...ok[Math.floor(Math.random() * ok.length)], keyword };
  }
  /** 他自己刷完一个，并写一两句反应（反应是模型写的，不是模板） */
  async function browseOne({ brain } = {}) {
    if (!brain) return null;
    const picked = await pick();
    if (!picked) {
      log?.info?.('B站：挑不出新视频（可能都看过了）');
      return null;
    }
    const info = await detail(picked.bvid);
    const lines = [];
    lines.push(`标题：${info.title}`);
    if (info.up) lines.push(`UP主：${info.up}`);
    if (info.desc) lines.push(`简介：${info.desc}`);
    if (info.tags.length) lines.push(`标签：${info.tags.join('、')}`);
    if (info.duration) lines.push(`时长：${durText(info.duration)}`);
    if (info.comments.length) {
      lines.push('热门评论：');
      for (const c of info.comments) lines.push('- ' + c);
    }
    let her = '';
    try {
      her = await brain._complete(
        [
          { role: 'system', content: REACTION_SYSTEM },
          { role: 'user', content: lines.join('\n') },
        ],
        conf.reactionMaxTokens,
        0.95,
        { timeoutMs: 25000 },
      );
      her = clean(her, 80).replace(/^["'“「『]|["'”」』]$/g, '');
    } catch (e) {
      log?.warn?.(`B站：反应没写出来（照样记下视频）: ${e.message}`);
    }
    const rec = {
      bvid: info.bvid,
      aid: info.aid,
      title: info.title,
      up: info.up,
      desc: info.desc,
      duration: info.duration,
      tags: info.tags,
      comments: info.comments,
      her,
      keyword: picked.keyword || '',
      at: now(),
      url: info.url,
    };
    st.watched.push(rec);
    if (st.watched.length > (Number(conf.maxWatched) || 200)) st.watched = st.watched.slice(-Number(conf.maxWatched || 200));
    st.seen.push(info.bvid);
    if (st.seen.length > 400) st.seen = st.seen.slice(-400);
    st.lastAt = now();
    st.day = dayKeyOf(now());
    st.dayCount = Number(st.dayCount || 0) + 1;
    save();
    log?.info?.(`B站：刷到《${info.title}》（${info.up || '未知UP'}）→ ${her || '（没写感想）'}`);
    // 让她自己的生活也记上一笔：这是她刚自己做的事，不是别人让她做的
    try {
      if (typeof onBrowse === 'function') onBrowse({ rec });
    } catch (e) {
      log?.debug?.('B站：通知自己的生活这一步出错 ' + (e && e.message));
    }
    // 让她自己判断喜不喜欢这个UP主（喜欢就记住原因，以后优先刷）
    try {
      await judgeLike({ brain, rec });
    } catch (e) {
      log?.debug?.('B站：判断喜欢这一步出错 ' + (e && e.message));
    }
    return rec;
  }

  /** 最近刷到的（默认 24 小时内） */
  function recent({ limit = 5, hours = 24 } = {}) {
    const cut = now() - Number(hours) * 3600 * 1000;
    return st.watched.filter((w) => (w.at || 0) >= cut).slice(-limit).reverse();
  }

  /** 拼一段给私聊用的上下文；群里不注入（这是她自己的事，不是群聊谈资） */
  function contextFor({ scene = 'c2c' } = {}) {
    if (scene !== 'c2c') return '';
    const list = recent({ limit: Number(conf.injectCount) || 3, hours: 36 });
    if (!list.length) return '';
    const lines = ['## 你刚在B站刷到的（你自己逛的，不是他让你看的）'];
    for (const w of list) {
      const who = w.up ? `（${w.up}）` : '';
      const take = w.her ? ` 你当时想：${w.her}` : '';
      lines.push(`- 《${w.title}》${who}${take}`);
    }
    lines.push('如果有人问你在干嘛、最近看了什么，可以自然提一句；没人问就别主动扯。');
    return lines.join('\n').slice(0, Number(conf.injectChars) || 380);
  }

  function list({ limit = 5 } = {}) {
    const arr = st.watched.slice(-limit).reverse();
    if (!arr.length) return '';
    return arr
      .map((w, i) => {
        const bits = [`${i + 1}. 《${w.title}》`];
        if (w.up) bits.push(`UP：${w.up}`);
        if (w.duration) bits.push(`时长：${durText(w.duration)}`);
        if (w.her) bits.push(`我想：${w.her}`);
        return bits.join(' ');
      })
      .join('\n');
  }

  /** 她喜欢的UP主（按喜欢次数排） */
  function likedUps({ limit = 8 } = {}) {
    maybeReload();
    return Object.values(st.ups || {})
      .sort((a, b) => (b.count || 0) - (a.count || 0) || (b.lastAt || 0) - (a.lastAt || 0))
      .slice(0, limit);
  }

  function state() {
    const day = dayKeyOf(now());
    return {
      enabled: !!conf.enabled,
      today: st.day === day ? Number(st.dayCount || 0) : 0,
      maxPerDay: Number(conf.maxPerDay) || 4,
      total: st.watched.length,
      lastAt: st.lastAt || 0,
      interests: Array.isArray(conf.interests) ? conf.interests : [],
      paused: !!st.paused,
      ups: Object.keys(st.ups || {}).length,
      shareToday: st.shareDay === day ? Number(st.shareCount || 0) : 0,
      sharePerDay: Number(conf.sharePerDay) || 3,
    };
  }

  const JUDGE_SYSTEM = [
    '你刚看完一个视频。判断你喜不喜欢这个视频 / 这个UP主，以及为什么。',
    '只输出一行 JSON：{\"like\":true,\"why\":\"不超过20字的喜欢原因\"}；不喜欢就 like:false。不要输出别的。',
  ].join('\n');

  /** 刷完让她自己判断喜不喜欢；喜欢就记住这个UP主和原因，以后优先刷 */
  async function judgeLike({ brain, rec } = {}) {
    if (!conf.judgeLike || !brain || !rec) return;
    const text = [`标题：${rec.title}`, rec.up ? `UP主：${rec.up}` : '', rec.desc ? `简介：${rec.desc}` : '', rec.her ? `你当时说：${rec.her}` : '']
      .filter(Boolean)
      .join('\n');
    let out = '';
    try {
      out = await brain._complete(
        [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: text },
        ],
        conf.judgeMaxTokens,
        0.3,
        { timeoutMs: 20000 },
      );
    } catch (e) {
      log?.debug?.(`B站：判断喜不喜欢失败（不影响记录）: ${e.message}`);
      return;
    }
    const m = String(out || '').match(/\{[\s\S]*\}/);
    if (!m) return;
    let j = null;
    try {
      j = JSON.parse(m[0]);
    } catch (e) {
      return;
    }
    if (!j || !j.like) return;
    const name = rec.up || '';
    if (!name) return;
    const why = clean(j.why, 40);
    const prev = st.ups[name] || { name, count: 0, why: '' };
    st.ups[name] = { name, count: (Number(prev.count) || 0) + 1, why: why || prev.why || '', lastAt: now() };
    // 最多记 maxUps 个，去掉最久没看的
    const names = Object.keys(st.ups);
    const cap = Number(conf.maxUps) || 40;
    if (names.length > cap) {
      names
        .sort((a, b) => (st.ups[a].lastAt || 0) - (st.ups[b].lastAt || 0))
        .slice(0, names.length - cap)
        .forEach((n) => delete st.ups[n]);
    }
    rec.liked = true;
    rec.likeWhy = why;
    save();
    log?.info?.(`B站：喜欢「${name}」（${why || '没写原因'}）`);
  }

  /** 该不该主动分享：每天 3 条、间隔 3 小时、22-9 点不发 */
  function shareDue() {
    if (!conf.enabled) return { due: false, reason: 'off' };
    maybeReload();
    if (st.paused) return { due: false, reason: 'paused' };
    const h = hourOf(now());
    if (inQuietHours(h, conf.shareQuietHours)) return { due: false, reason: 'quiet' };
    const day = dayKeyOf(now());
    const count = st.shareDay === day ? Number(st.shareCount || 0) : 0;
    if (count >= (Number(conf.sharePerDay) || 3)) return { due: false, reason: 'day-limit' };
    const last = st.shared.length ? st.shared[st.shared.length - 1].at : 0;
    if (last && now() - last < Number(conf.shareMinGapMinutes) * 60000) return { due: false, reason: 'gap' };
    const within = Number(conf.shareWithinHours) * 3600 * 1000;
    const cand = st.watched.filter((w) => w.her && !w.sharedAt && now() - (w.at || 0) < within);
    if (!cand.length) return { due: false, reason: 'nothing' };
    return { due: true, candidate: cand[cand.length - 1] };
  }

  /** 取一条去分享（标记已分享、记配额） */
  function takeShare() {
    const d = shareDue();
    if (!d.due) return null;
    const w = d.candidate;
    const day = dayKeyOf(now());
    w.sharedAt = now();
    st.shareDay = day;
    st.shareCount = (Number(st.shareCount) || 0) + 1;
    st.shared.push({ bvid: w.bvid, at: now() });
    if (st.shared.length > 100) st.shared = st.shared.slice(-100);
    save();
    return w;
  }

  /** 主人控制：暂停 / 恢复刷 B 站（写进 bili.json，重启也记得） */
  function setPaused(v, by = 'owner') {
    st.paused = !!v;
    st.pausedAt = st.paused ? now() : 0;
    st.pausedBy = st.paused ? String(by) : '';
    save();
    log?.info?.(`B站：${st.paused ? '已按主人要求暂停' : '已恢复'}`);
    return st.paused;
  }
  load();
  return {
    conf,
    file: filePath,
    dueNow,
    browseOne,
    recent,
    contextFor,
    list,
    state,
    save,
    setPaused,
    shareDue,
    takeShare,
    judgeLike,
    likedUps,
    _maybeReload: maybeReload,
    // 导出给测试用
    _pick: pick,
    _detail: detail,
    _hotList: hotList,
    _searchList: searchList,
  };
}

module.exports = { BILI_DEFAULTS, createBiliBrowser, BILI_REACTION_SYSTEM: REACTION_SYSTEM, durText, dayKeyOf, inQuietHours };
