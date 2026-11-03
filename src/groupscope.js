'use strict';
/**
 * 群消息范围检测。
 *
 * 背景（官方限制，绕不过去）：QQ 群里机器人默认**只收 @ 自己的消息**。
 * 想让机器人看到群里的全部消息，必须由**群主**在手机 QQ 的群设置里，
 * 把「接收消息范围」改成「接收全部群消息」（管理员不行；电脑版不支持这个设置）。
 *
 * 所以这里做的事不是"绕过"，而是**自动发现哪些群还没开**，
 * 然后在私聊里顺口提醒主人去开 —— 免得他以为机器人坏了。
 *
 * 判定方法：
 *   - 收到过任何一条「没 @ 我」的群消息 → 这个群的全量消息已开（sawAll = true），不用管；
 *   - 只收到过 @ 我的消息（atCount >= minAtEvents 且从未见到非 @）→ 认为没开，值得提醒。
 */
const fs = require('fs');
const path = require('path');

const GROUP_SCOPE_DEFAULTS = {
  enabled: true,
  minAtEvents: 2,        // 至少收到过几次 @ 才判断（避免刚进群就误报）
  maxHints: 3,           // 私聊里最多提几个群
  hintCooldownHours: 24, // 同一个群提醒过之后，多少小时内不再提
};

function createGroupScope({ file = null, cfg = {}, log = null, now = Date.now } = {}) {
  const opts = { ...GROUP_SCOPE_DEFAULTS, ...cfg };
  const groups = new Map(); // groupId -> { atCount, sawAll, lastAt, hintedAt }
  let saveTimer = null;

  if (file) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [id, v] of Object.entries(raw.groups || {})) {
          groups.set(id, {
            atCount: Number(v.atCount) || 0,
            sawAll: !!v.sawAll,
            lastAt: Number(v.lastAt) || 0,
            hintedAt: Number(v.hintedAt) || 0,
          });
        }
      }
    } catch (e) {
      log?.warn?.('群消息范围记录读取失败，当作空的:', e.message);
    }
  }

  function flush() {
    if (!file) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const out = { updatedAt: new Date(now()).toISOString(), groups: {} };
      for (const [id, v] of groups) out.groups[id] = v;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (e) {
      log?.warn?.('群消息范围记录保存失败:', e.message);
    }
  }

  function schedule() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  /** 收到一条群消息时调用（mentioned = 是不是 @ 了我 / 叫了我的名字） */
  function note(msg) {
    if (opts.enabled === false || !msg || msg.scene !== 'group' || !msg.groupId) return;
    const st = groups.get(msg.groupId) || { atCount: 0, sawAll: false, lastAt: 0, hintedAt: 0 };
    st.lastAt = now();
    if (msg.mentioned) st.atCount += 1;
    else st.sawAll = true;
    groups.set(msg.groupId, st);
    schedule();
  }

  /** 私聊时给模型的提醒（只返回真的需要他动手的群） */
  function hints(labelOf = null) {
    if (opts.enabled === false) return [];
    const out = [];
    const coolMs = (opts.hintCooldownHours || 24) * 3600 * 1000;
    for (const [id, v] of groups) {
      if (v.sawAll) continue;
      if (v.atCount < (opts.minAtEvents || 2)) continue;
      out.push({ groupId: id, atCount: v.atCount, label: labelOf ? labelOf(id) : id.slice(0, 8), state: v });
    }
    out.sort((a, b) => b.atCount - a.atCount);
    return out.slice(0, opts.maxHints || 3)
      .filter((h) => !h.state.hintedAt || now() - h.state.hintedAt > coolMs)
      .map((h) => ({
        groupId: h.groupId,
        label: h.label,
        text: `${h.label} 只给我推 @ 我的消息（我收不到群里平时的聊天）`,
      }));
  }

  /** 已经提醒过，记一下（防止每句私聊都提） */
  function markHinted(groupIds = []) {
    const t = now();
    let changed = false;
    for (const id of groupIds) {
      const st = groups.get(id);
      if (st) { st.hintedAt = t; changed = true; }
    }
    if (changed) flush();
  }

  return { note, hints, markHinted, flush, groups, settings: opts, snapshot: () => Object.fromEntries(groups) };
}

module.exports = { GROUP_SCOPE_DEFAULTS, createGroupScope };
