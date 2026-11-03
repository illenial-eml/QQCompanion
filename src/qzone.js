'use strict';
/**
 * QQ 空间（Qzone）——目前只做「看」，不做「发」。
 *
 * 为什么这么设计：
 *  - 小号已经被风控盯过（3 轮实名认证）。空间发说说/评论比私聊更容易被抓，先只读最安全。
 *  - 读动态靠 QQ 的 cgi（emotion_cgi_msglist_v6 等），需要先拿 qzone 域的 cookie；
 *    cookie 用 NapCat 的 get_cookies 拿，拿不到就放弃（不硬编密码、不塞死数据）。
 *  - 所有动作都 try/catch，失败只记日志，永远不影响聊天主流程。
 *
 * 配置（config.json）：
 *   "qzone": {
 *     "enabled": false,        // 默认关，确认能被读到再开
 *     "pollMinutes": 20,       // 多久看一次
 *     "maxItems": 5,           // 每次最多取几条
 *     "notifyOwner": true      // 看到新动态要不要私聊告诉主人
 *   }
 */

const QZONE_DOMAIN = 'qzone.qq.com';

/** 把 NapCat 返回的 cookie 头整理成「a=b; c=d」 */
function cookieHeader(cookies) {
  if (!cookies) return '';
  if (typeof cookies === 'string') return cookies;
  const list = Array.isArray(cookies) ? cookies : Object.entries(cookies).map(([name, value]) => ({ name, value }));
  return list
    .filter((c) => c && c.name && c.value !== undefined)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** 从 cgi 返回里抽出说说列表（字段名各版本不一致，做兜底） */
function normalizeFeed(payload) {
  const out = [];
  const walk = (obj) => {
    if (!obj) return;
    if (Array.isArray(obj)) {
      for (const it of obj) walk(it);
      return;
    }
    if (typeof obj !== 'object') return;
    const content = obj.content || obj.summary || obj.rt_con || '';
    if (content && (obj.tid || obj.feedskey || obj.curlikekey || obj.uin)) {
      out.push({
        uin: String(obj.uin || ''),
        name: obj.name || obj.nickname || '',
        content: String(content).replace(/<[^>]+>/g, '').slice(0, 200),
        time: Number(obj.createTime || obj.create_time || obj.time || 0),
        tid: String(obj.tid || ''),
      });
      return;
    }
    for (const v of Object.values(obj)) walk(v);
  };
  walk(payload);
  const seen = new Set();
  return out.filter((it) => {
    const key = `${it.uin}:${it.tid || it.content.slice(0, 20)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @param {object} opts
 * @param {{callAction:(action:string, params?:object)=>Promise<any>}} opts.client
 * @param {object} [opts.cfg]
 * @param {object} [opts.log]
 * @param {(items:object[])=>void} [opts.onDiscover]
 */
function createQzone({ client, cfg = {}, log = null, onDiscover = null } = {}) {
  const enabled = cfg.enabled === true;
  const pollMinutes = Math.max(5, Number(cfg.pollMinutes) || 20);
  const maxItems = Math.max(1, Number(cfg.maxItems) || 5);
  let timer = null;
  let lastSeen = new Set();
  let cachedCookies = null;
  let cachedAt = 0;

  async function getCookies() {
    if (cachedCookies && Date.now() - cachedAt < 10 * 60 * 1000) return cachedCookies;
    const actions = [
      ['get_cookies', { domain: QZONE_DOMAIN }],
      ['get_cookies', { domain: 'qq.com' }],
      ['get_cookies', {}],
    ];
    for (const [action, params] of actions) {
      try {
        const res = await client.callAction(action, params);
        const header = cookieHeader(res?.cookies || res?.data?.cookies || res);
        if (header && header.includes('=')) {
          cachedCookies = header;
          cachedAt = Date.now();
          return header;
        }
      } catch (e) {
        log?.debug?.(`qzone 取 cookie 失败(${action}): ${e.message}`);
      }
    }
    return '';
  }

  /** 拉一次「谁发了新说说」；这是 QQ 的 cgi，参数按常见形式传，失败就返回空 */
  async function fetchFeed() {
    const cookie = await getCookies();
    if (!cookie) {
      log?.debug?.('qzone：没有 cookie，先跳过（不影响聊天）');
      return [];
    }
    try {
      const res = await client.callAction('get_qzone_msg_list', { cookie, count: maxItems });
      const items = normalizeFeed(res).slice(0, maxItems);
      return items;
    } catch (e) {
      log?.debug?.(`qzone 读动态失败（NapCat 可能没这个 action）: ${e.message}`);
      return [];
    }
  }

  async function tick() {
    const items = await fetchFeed();
    if (!items.length) return [];
    const fresh = items.filter((it) => {
      const key = `${it.uin}:${it.tid || it.content.slice(0, 20)}`;
      return !lastSeen.has(key);
    });
    for (const it of items) lastSeen.add(`${it.uin}:${it.tid || it.content.slice(0, 20)}`);
    if (lastSeen.size > 200) lastSeen = new Set([...lastSeen].slice(-100));
    if (fresh.length && onDiscover) {
      try {
        onDiscover(fresh);
      } catch (e) {
        log?.warn?.(`qzone 回调失败: ${e.message}`);
      }
    }
    if (fresh.length) log?.info?.(`QQ 空间：看到 ${fresh.length} 条新动态（${fresh[0].name || fresh[0].uin}：${fresh[0].content.slice(0, 20)}…）`);
    return fresh;
  }

  function start() {
    if (!enabled) {
      log?.info?.('QQ 空间：未开启（默认只读且关闭）');
      return;
    }
    if (timer) return;
    log?.info?.(`QQ 空间：已开启，每 ${pollMinutes} 分钟看一次（只看不回）`);
    timer = setInterval(() => {
      tick().catch((e) => log?.debug?.(`qzone tick 失败: ${e.message}`));
    }, pollMinutes * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, fetchFeed, getCookies, get enabled() { return enabled; } };
}

module.exports = { createQzone, normalizeFeed, cookieHeader };
