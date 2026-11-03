'use strict';
/**
 * 「认主人」：搞清楚群里哪句话是他本人（也就是你）说的。
 *
 * 为什么要单独做这件事：QQ 官方机器人在**私聊**里拿到的是 `user_openid`，
 * 在**群里**拿到的是每个人在该群的 `member_openid` —— 两个 ID 不是一回事，
 * 没法直接对上。所以这里用两条线索认人：
 *   1. 配置里写死的 id / 昵称（私聊 openid 一定在配置里，能 100% 认出你）
 *   2. 群昵称：你在群里说话时，只要昵称命中，就先认定是你，
 *      顺便把这个群的 member_openid 记进 data/owners.json —— 以后就不再依赖昵称了
 */
const fs = require('fs');
const path = require('path');

const OWNER_DEFAULTS = {
  enabled: true,     // 总开关
  ids: [],           // 已知的 openid（私聊 user_openid / 群 member_openid）
  names: [],         // 昵称（群昵称或 QQ 昵称），大小写不敏感
  aliases: [],       // 昵称「特征词」：只要昵称里含这些词就算他（换昵称也认得出来）
  learn: true,       // 按昵称认出人之后，自动把 member_openid 记下来
  alwaysReply: false, // 你在群里说话时是否「一定接」（默认 false：要叫它名字 / @ 它它才反应）
};

function normName(s) {
  return String(s || '').trim().toLowerCase();
}

/** 认别名用：去掉空格/下划线/标点再比，这样 "Alice"、"eml"、"E.M.L" 都能命中 "eml" */
function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s_\-.:：·|/\\@#()（）[\]]+/g, '');
}

/**
 * @param {object} o
 * @param {string|null} o.file   学习结果落盘路径（data/owners.json）
 * @param {object} o.cfg         qq.owner* 配置
 */
function createOwnerStore({ file = null, cfg = {}, log = null, now = Date.now } = {}) {
  const opts = { ...OWNER_DEFAULTS, ...cfg };
  const ids = new Set((opts.ids || []).filter(Boolean).map(String));
  const names = new Set((opts.names || []).filter(Boolean).map(String)); // 存原样，比较时再归一
  const aliases = (opts.aliases || []).filter(Boolean).map(normKey);
  const namesNorm = () => new Set([...names].map(normName));
  let loadedAt = null;

  // 读回上次学到的 id
  if (file) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const id of raw.ids || []) if (id) ids.add(String(id));
        for (const n of raw.names || []) if (n) names.add(String(n));
        loadedAt = raw.updatedAt || null;
      }
    } catch (e) {
      log?.warn?.('主人名单读取失败，当作空的:', e.message);
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const data = {
        updatedAt: new Date(now()).toISOString(),
        ids: [...ids],
        names: [...names],
      };
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (e) {
      log?.warn?.('主人名单保存失败:', e.message);
    }
  }

  /** 这条消息是不是他本人说的 */
  function match(msg) {
    if (opts.enabled === false || !msg) return { owner: false, reason: null };
    if (msg.userId && ids.has(String(msg.userId))) return { owner: true, reason: 'id' };
    if (msg.userName && namesNorm().has(normName(msg.userName))) return { owner: true, reason: 'name' };
    // 换昵称也认得出来：昵称里含「eml」「火鸡」「火鸟」这些特征词就是他
    if (msg.userName && aliases.length) {
      const key = normKey(msg.userName);
      const hit = aliases.find((a) => a && key.includes(a));
      if (hit) return { owner: true, reason: 'alias', alias: hit };
    }
    return { owner: false, reason: null };
  }

  /**
   * 按昵称认出来之后，把这个场景里的 id 记下来（只在 reason === 'name' 时调）。
   * 返回 true = 新学到了一条。
   */
  function learn(msg) {
    if (opts.enabled === false || opts.learn === false || !msg || !msg.userId) return false;
    if (ids.has(String(msg.userId))) return false;
    ids.add(String(msg.userId));
    if (msg.userName) names.add(String(msg.userName));
    save();
    log?.info?.(
      `认下主人：${msg.scene === 'group' ? '群 ' + (msg.groupId || '') + ' 里的' : '私聊里的'} ${msg.userName || ''}(${msg.userId})`
    );
    return true;
  }

  function addId(id, name = null) {
    if (!id) return false;
    if (ids.has(String(id))) return false;
    ids.add(String(id));
    if (name) names.add(String(name));
    save();
    return true;
  }

  return {
    match,
    learn,
    addId,
    settings: opts,
    loadedAt,
    ids: () => [...ids],
    names: () => [...names],
    aliases: () => [...aliases],
    save,
  };
}

module.exports = { OWNER_DEFAULTS, createOwnerStore, normName, normKey };
