'use strict';
/**
 * 名字簿：把「QQ 号 → 你给他设的备注名 / 群名片 / 昵称」记下来。
 *
 * 为什么需要它：
 *   - OneBot 推消息时只带 sender.card（群名片）或 sender.nickname，**不带好友备注**；
 *   - 主人嘴里说的是备注（「杨江豪」），而 QQ 昵称可能是「月季花」→ 对不上就答「我不认识」。
 *   - 所以启动后、以及每隔一段时间，用 get_friend_list / get_group_member_list 拉一遍，
 *     把 remark（备注）优先记下来，供「印象」和「她认人」共用。
 *
 * 纯本地，只读 OneBot 接口，不联网、不额外调模型。
 */

const fs = require('fs');
const path = require('path');

const NAMES_DEFAULTS = {
  enabled: true,
  file: 'data/names.json',
  refreshMinutes: 60,      // 多久拉一次（0 = 只在启动时拉一次）
  includeGroupMembers: true,
  maxGroups: 30,           // 最多拉多少个群的成员
  maxMembersPerGroup: 500,
  maxPeople: 3000,
};

/** 去掉句子里的语气/引号，方便拿它当人名查 */
function cleanName(s) {
  return String(s || '')
    .replace(/[「」『』“”"'’`]/g, '')
    .replace(/^(?:这个|那个|那个叫|叫)/, '')
    .replace(/(?:这个人|那人|同学|老师|朋友)$/, '')
    .trim();
}

/**
 * 从一句话里抽「他指的是谁」。
 * 例：
 *   「你觉得杨江豪这人怎么样」→ 杨江豪
 *   「杨江豪 你觉得他怎么样」→ 杨江豪
 *   「你对月季花什么印象」    → 月季花
 * 抽不到返回 ''（**绝不猜**，猜错比说不知道更糟）
 */
function extractPersonQuery(text) {
  const raw = String(text || '').trim().replace(/[？?！!。～~]+$/, '');
  if (!raw) return '';
  // 先确认这句确实在问「某个人」，否则整句都会被当成名字
  const ASK = /印象|怎么样|如何|什么人|是什么人|是谁|熟不熟|认识吗|了解吗|聊过吗|人好不好/;
  if (!ASK.test(raw)) return '';

  const t = raw
    .replace(/^你\s*对\s*/, '')
    .replace(/^你(?:觉得|认为|感觉|看|说)\s*/, '')
    .replace(/^对\s*/, '')
    .replace(/(?:这人|这个人|那个人|同学|老师)?(?:怎么样|如何|什么印象|印象怎么样|印象如何|是个什么样的人|是什么人|什么人|人怎么样|好不好|熟不熟|是谁|认识吗|了解吗|聊过吗)(?:呢|啊|呀|吧)?/g, ' ')
    .replace(/(?:我觉得|你觉得|你认为|你感觉|感觉|他|她|它|这个人|那个人)/g, ' ')
    .replace(/[「」『』“”"'’`，,。、\s]+/g, ' ')
    .trim();

  const STOP = new Set(['你', '我', '他', '她', '它', '这个', '那个', '这人', '这人呢']);
  const cand = t.split(/\s+/).map(cleanName).filter((x) => x && x.length >= 2 && x.length <= 16 && !STOP.has(x));
  if (!cand.length) return '';
  return cand[0].slice(0, 16);
}

function createNameBook({ file, cfg = {}, log = null, now = () => Date.now() } = {}) {  const conf = { ...NAMES_DEFAULTS, ...(cfg || {}) };
  const state = { version: 1, people: {} };

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data.people === 'object') {
        Object.assign(state.people, data.people);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log?.warn?.('名字簿读取失败，先当空的重来:', e.message);
    }
    return state;
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (e) {
      log?.warn?.('名字簿保存失败:', e.message);
    }
  }
  load();

  function upsert({ userId, nickname = '', card = '', remark = '', groupId = '' } = {}) {
    const id = String(userId || '').trim();
    if (!id || !/^\d{3,}$/.test(id)) return null;
    let p = state.people[id];
    if (!p) {
      p = { id, nickname: '', card: '', remark: '', groups: [], updatedAt: 0 };
      state.people[id] = p;
    }
    if (nickname && nickname !== p.nickname) p.nickname = String(nickname).slice(0, 40);
    if (card && card !== p.card) p.card = String(card).slice(0, 40);
    if (remark && remark !== p.remark) p.remark = String(remark).slice(0, 40);
    if (groupId) {
      const g = String(groupId);
      if (!p.groups.includes(g)) p.groups.push(g);
      if (p.groups.length > 50) p.groups = p.groups.slice(-50);
    }
    p.updatedAt = now();
    return p;
  }

  /** 名字簿只在同步结束时统一落盘（一次拉几百人，逐条写盘太费） */
  function saveIfDirty() {
    save();
  }

  /** 显示名：备注 > 群名片 > 昵称 */
  function displayName(userId) {
    const p = state.people[String(userId || '')];
    if (!p) return '';
    return p.remark || p.card || p.nickname || '';
  }

  /** 一个人的所有可能叫法（给「印象」存别名用） */
  function aliasesOf(userId) {
    const p = state.people[String(userId || '')];
    if (!p) return [];
    const set = new Set();
    for (const s of [p.remark, p.card, p.nickname]) {
      const v = String(s || '').trim();
      if (v && v.length <= 24) set.add(v);
    }
    return [...set];
  }

  /**
   * 在文本里找人：已知名字（备注/群名片/昵称）按长度从长到短匹配。
   * 返回 { userId, name } 或 null。**只认真实存在的名字**，不做模糊猜测。
   */
  function resolve(text, { minLen = 2 } = {}) {
    const t = String(text || '');
    if (!t) return null;
    const cands = [];
    for (const p of Object.values(state.people)) {
      for (const s of [p.remark, p.card, p.nickname]) {
        const v = String(s || '').trim();
        if (!v || v.length < minLen || v.length > 24) continue;
        cands.push({ name: v, userId: p.id, isRemark: s === p.remark });
      }
    }
    cands.sort((a, b) => b.name.length - a.name.length);
    for (const c of cands) {
      if (t.includes(c.name)) return { userId: c.userId, name: c.name, isRemark: c.isRemark };
    }
    return null;
  }

  /** 按名字/id 查一条（给印象查询用） */
  function find(query) {
    const q = cleanName(query);
    if (!q) return null;
    const byId = state.people[q];
    if (byId) return byId;
    // 完全相等 > 前缀 > 包含
    const list = Object.values(state.people);
    const exact = list.find((p) => [p.remark, p.card, p.nickname].some((s) => String(s || '').trim() === q));
    if (exact) return exact;
    const pref = list.find((p) => [p.remark, p.card, p.nickname].some((s) => String(s || '').trim().startsWith(q)));
    if (pref) return pref;
    return null;
  }

  function size() {
    return Object.keys(state.people).length;
  }

  /** 拉好友列表（带备注） */
  async function syncFriends(client) {
    if (!client || typeof client.getFriendList !== 'function') return 0;
    const list = await client.getFriendList().catch(() => null);
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const f of list) {
      const id = f.user_id ?? f.userId;
      const p = upsert({ userId: id, nickname: f.nickname, remark: f.remark || f.remarkName || '' });
      if (p) n += 1;
    }
    save();
    return n;
  }

  /** 拉群成员（群名片也是「她认人」的重要来源） */
  async function syncGroupMembers(client, groupIds = []) {
    if (!client || typeof client.api !== 'function') return 0;
    let n = 0;
    for (const gid of groupIds.slice(0, conf.maxGroups)) {
      const list = await client.api('get_group_member_list', { group_id: Number(gid), no_cache: false }).catch(() => null);
      if (!Array.isArray(list)) continue;
      for (const m of list.slice(0, conf.maxMembersPerGroup)) {
        const id = m.user_id ?? m.userId;
        const p = upsert({
          userId: id,
          nickname: m.nickname,
          card: m.card || m.cardName || '',
          remark: m.remark || '',
          groupId: gid,
        });
        if (p) n += 1;
      }
    }
    save();
    return n;
  }

  /** 启动时、以及定时刷新 */
  async function syncAll(client) {
    if (conf.enabled === false) return { friends: 0, members: 0 };
    const friends = await syncFriends(client).catch(() => 0);
    let members = 0;
    if (conf.includeGroupMembers) {
      const gl = await client.getGroupList().catch(() => null);
      const ids = Array.isArray(gl) ? gl.map((g) => g.group_id ?? g.groupId).filter(Boolean) : [];
      members = await syncGroupMembers(client, ids).catch(() => 0);
    }
    trim();
    save();
    log?.info?.(`名字簿：好友 ${friends} 个、群成员 ${members} 条，一共认识 ${size()} 个人`);
    return { friends, members };
  }

  function trim() {
    const list = Object.values(state.people);
    if (list.length <= conf.maxPeople) return;
    list.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    for (const p of list.slice(0, list.length - conf.maxPeople)) delete state.people[p.id];
  }

  return {
    load, save, upsert, displayName, aliasesOf, resolve, find, size, syncAll, syncFriends, syncGroupMembers,
    settings: conf,
    state: () => state,
  };
}

/**
 * 「主人问 X 印象」时定位这个人。
 * 返回：{ id, name }（找到了）/ { name }（有名字但没记录）/ null（连名字都没认出来）
 * 顺序：名字簿里的真人名 → 抽出来的名字 → 印象库模糊匹配。
 */
function resolveImpressionQuery(text, { book = null, people = null } = {}) {
  const byBook = book ? book.resolve(text) : null;
  if (byBook) return { id: byBook.userId, name: byBook.name };
  const name = extractPersonQuery(text);
  if (!name) return null;
  const hit = people && typeof people.find === 'function' ? people.find(name) : null;
  if (hit) return { id: hit.id, name: hit.name || name };
  // 没记录时也别抢「今天天气怎么样」这种话：只有明显在说「某个人」才认
  const PERSON_CUE = /印象|这人|这个人|那个人|是谁|什么样的人|人怎么样|认识吗|熟悉吗|熟不熟|聊过吗/;
  if (!PERSON_CUE.test(String(text || ''))) return null;
  return { name };
}

module.exports = { NAMES_DEFAULTS, createNameBook, extractPersonQuery, cleanName, resolveImpressionQuery };
