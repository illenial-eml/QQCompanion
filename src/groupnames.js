'use strict';
/**
 * 群名记录：把「群 openid」和「人看得懂的群名」对上。
 *
 * 为什么要单独存：QQ 机器人的群消息事件里**只有 group_openid，没有群名**，
 * 官方也没给「查群资料」的接口。所以群名只能这样来：
 *   1. config.json 里 `qq.groupNames` 先塞种子（键可以是「群1」这种编号，也可以是 openid）
 *   2. 你在群里说一句「群名叫 bio人能飞」→ 它把当前群记下来
 *   3. 你在私聊里说「群2叫 test」→ 按编号改名字
 * 记住之后，私聊里的小结、提示词里的群聊近况都会用真名字，而不是「群1」「群2」。
 */

const fs = require('node:fs');
const path = require('node:path');

const GROUP_NAME_DEFAULTS = {
  enabled: true,
  learning: true,      // 允许用聊天命令教它群名
  maxNameChars: 24,    // 群名最长多少字
  saveDelayMs: 1500,
};

/** 去掉首尾的引号、书名号、括号、空白和句末标点 */
function cleanName(raw, maxChars = 24) {
  let s = String(raw || '').trim();
  s = s.replace(/^[「『"'"'《〈【\[\(（\s]+/, '').replace(/[」』"'"'》〉】\]\)）\s]+$/, '');
  s = s.replace(/[。．.!！,，、~～\s]+$/, '').trim();
  s = s.replace(/\s+/g, ' ');
  if (!s) return '';
  if (s.length > maxChars) s = s.slice(0, maxChars);
  // 明显不是名字的（一整句话）不要
  if (/[？?]$/.test(s)) return '';
  return s;
}

function createGroupNames({ file = null, cfg = {}, log = null, now = Date.now, timer = { set: setTimeout, clear: clearTimeout } } = {}) {
  const opt = { ...GROUP_NAME_DEFAULTS, ...(cfg || {}) };
  const map = new Map();            // groupId -> { name, label, source, at }
  let loaded = false;
  let timerId = null;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
      for (const [groupId, v] of Object.entries(data.groups || {})) {
        if (!v || !v.name) continue;
        map.set(groupId, {
          name: String(v.name).slice(0, opt.maxNameChars),
          label: v.label || '',
          source: v.source || 'file',
          at: v.at || 0,
        });
      }
    } catch {
      /* 没有就是空的 */
    }
  }

  function saveNow() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const groups = {};
      for (const [groupId, v] of map) groups[groupId] = v;
      const data = { version: 1, updatedAt: new Date(now()).toISOString(), groups };
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      log?.warn?.('群名写盘失败:', e.message);
    }
  }

  function schedule() {
    if (!file || timerId) return;
    timerId = timer.set(() => { timerId = null; saveNow(); }, opt.saveDelayMs);
    timerId?.unref?.();
  }

  function nameOf(groupId) {
    if (!groupId) return '';
    load();
    return map.get(groupId)?.name || '';
  }

  function labelOf(groupId) {
    if (!groupId) return '';
    load();
    return map.get(groupId)?.label || '';
  }

  /** 记下某个群的群名；label 是它在这个目录里的编号（群1/群2），存下来方便显示 */
  function set(groupId, name, { label = '', source = 'learn' } = {}) {
    load();
    const clean = cleanName(name, opt.maxNameChars);
    if (!groupId || !clean) return null;
    const prev = map.get(groupId);
    if (prev && prev.name === clean && (!label || prev.label === label)) return { groupId, name: clean, label: prev.label, unchanged: true };
    const rec = { name: clean, label: label || prev?.label || '', source, at: now() };
    map.set(groupId, rec);
    schedule();
    log?.info?.(`记住群名：${rec.label ? rec.label + ' = ' : ''}${clean}（${source}）`);
    return { groupId, name: clean, label: rec.label };
  }

  /**
   * 用 config 里的 `qq.groupNames` 做种子。
   * 键可以是「群1」这种编号，也可以是 group_openid；resolveLabel 用来把编号换成 openid。
   */
  function seedFromConfig(seed = null, resolveLabel = null) {
    load();
    const src = seed || opt.seed || {};
    let n = 0;
    for (const [key, value] of Object.entries(src || {})) {
      const name = cleanName(value, opt.maxNameChars);
      if (!key || !name) continue;
      let groupId = key;
      let label = '';
      if (/^群\s*\d+$/.test(key)) {
        label = key.replace(/\s+/g, '');
        groupId = resolveLabel ? resolveLabel(label) : '';
        if (!groupId) continue;
      }
      const cur = map.get(groupId);
      if (cur && cur.source === 'learn') continue; // 你教过的优先，种子不覆盖
      set(groupId, name, { label: label || cur?.label || '', source: 'config' });
      n += 1;
    }
    return n;
  }

  /**
   * 从一句话里认出「群名命令」。只有主人说才调这个（调用方负责判断）。
   * 群里：「群名叫 bio人能飞」「这个群叫test」「改群名：xxx」「本群名字是xxx」
   * 私聊：「群2叫 test」「第 2 个群叫 test」「群2名字改成 test」
   */
  function learn({ text, groupId = '', isGroup = false, labelOf: labelFn = null, resolveLabel = null } = {}) {
    if (!opt.enabled || opt.learning === false) return null;
    load();
    const t = String(text || '').trim();
    if (!t || t.length > 60) return null;

    // 私聊里按编号教
    if (!isGroup) {
      const m = /^(?:第\s*)?群\s*(\d+)\s*(?:个群)?\s*(?:的)?\s*(?:名字|群名)?\s*(?:叫|是|改成|改叫|改成叫)\s*(.+)$/.exec(t);
      if (!m) return null;
      const label = `群${m[1]}`;
      const name = cleanName(m[2], opt.maxNameChars);
      if (!name) return null;
      const target = resolveLabel ? resolveLabel(label) : '';
      if (!target) {
        log?.warn?.(`没找到编号为「${label}」的群（可能它还没在群里说过话）`);
        return { label, name, groupId: '', missing: true };
      }
      const hit = set(target, name, { label, source: 'learn' });
      return hit ? { ...hit, label, missing: false } : null;
    }

    // 群里：说当前群的名字
    const patterns = [
      /^(?:这个群|本群|咱们群|这群)?\s*(?:的)?\s*群?名(?:字)?\s*(?:就)?\s*(?:叫|是|改成|改叫|改成叫)\s*(.+)$/,
      /^(?:这个群|本群|咱们群|这群)\s*(?:就)?\s*(?:叫|是|改名(?:成叫|成|叫)?)\s*(.+)$/,
      /^改(?:一下)?\s*群?名(?:字)?\s*(?:为|成|叫)?\s*[:：]?\s*(.+)$/,
      /^记(?:一下|住)?\s*[:：]?\s*群名\s*(?:叫|是)?\s*(.+)$/,
    ];
    for (const re of patterns) {
      const m = re.exec(t);
      if (!m) continue;
      const name = cleanName(m[1], opt.maxNameChars);
      if (!name) continue;
      const label = labelFn && groupId ? labelFn(groupId) : '';
      const hit = set(groupId, name, { label, source: 'learn' });
      return hit ? { ...hit, label, missing: !groupId } : null;
    }
    return null;
  }

  function entries() {
    load();
    return [...map.entries()].map(([groupId, v]) => ({ groupId, ...v }));
  }

  function snapshot() {
    load();
    return entries();
  }

  function flush() {
    if (timerId) { timer.clear(timerId); timerId = null; }
    saveNow();
  }

  return { nameOf, labelOf, set, seedFromConfig, learn, entries, snapshot, flush, settings: opt };
}

module.exports = { createGroupNames, GROUP_NAME_DEFAULTS, cleanName };
