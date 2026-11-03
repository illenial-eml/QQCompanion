'use strict';
/**
 * 「潜水模式」：你在 QQ 里发一句话，它就不在群里说话了。
 *
 * 为什么需要：
 *   有时候群里在聊你在意的事，但它在那儿插话很烦；你又不想关掉整个群功能。
 *   潜水期间它照旧把群里的消息记下来（群聊日志 + 群记忆），只是**一个字都不发**，
 *   连 @ 它、连贴表情都不发；你说「浮上来」它才恢复，并可以给你一份潜水期间的小结。
 *
 * 只有「主人」（src/owner.js 认出来的那个人）的命令才算，别人说「潜水」它不听。
 */

const fs = require('node:fs');
const path = require('node:path');

const MODE_DEFAULTS = {
  enabled: true,
  silentCommands: ['潜水', '进入潜水', '开始潜水', '安静点', '静音'],
  wakeCommands: ['浮上来', '出来', '醒醒', '别潜水了', '恢复'],
  summaryCommands: ['潜水总结', '总结一下', '群里都聊啥了'],
  summarize: false,        // 总开关：要不要它「总结群消息」（默认关：总结最费时间，输出也容易又长又慢）
  summarizeOnWake: false,  // 你说「浮上来」时顺带给你潜水小结（summarize 关着时不生效）
  summaryHours: 12,        // 小结最多回看多少小时
  summaryMaxGroups: 4,     // 小结最多概括几个群
};

/** 去掉前面的 / 或 ！、句末标点、多余空格，方便「/潜水」「潜水。」都认 */
function normalizeCmd(text) {
  return String(text || '')
    .trim()
    .replace(/^[/!！]/, '')
    .replace(/[\s。.!！~～…]+$/g, '')
    .replace(/\s+/g, '');
}

/**
 * 认命令。返回 'silent' | 'wake' | 'summary' | null
 * 只认「整句就是命令」的情况（避免把「今天去潜水了」误判）。
 */
function matchModeCommand(text, cfg = MODE_DEFAULTS) {
  const t = normalizeCmd(text);
  if (!t) return null;
  const hit = (list) => (list || []).some((c) => normalizeCmd(c) === t);
  if (hit(cfg.silentCommands)) return 'silent';
  if (hit(cfg.wakeCommands)) return 'wake';
  if (hit(cfg.summaryCommands)) return 'summary';
  return null;
}

/**
 * 状态存盘：`data/state.json`（重启后还在潜水状态，不然一重启就又开始说话了）
 */
function createModeStore({ file = null, cfg = {}, log = null, now = Date.now } = {}) {
  const opt = { ...MODE_DEFAULTS, ...(cfg || {}) };
  let state = { silent: false, since: 0, by: '' };

  if (file) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (raw && typeof raw === 'object') {
          state = {
            silent: raw.silent === true,
            since: Number(raw.since) || 0,
            by: raw.by ? String(raw.by) : '',
          };
        }
      }
    } catch (e) {
      log?.warn?.('潜水状态读取失败，当作正常状态:', e.message);
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date(now()).toISOString() }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      log?.warn?.('潜水状态保存失败:', e.message);
    }
  }

  function isSilent() {
    return opt.enabled !== false && state.silent === true;
  }

  function set(on, { by = '' } = {}) {
    if (on) {
      state = { silent: true, since: now(), by: String(by || '') };
      log?.info(`进入潜水模式（${by || '他'}说的）：群里一个字都不发，但会把消息记下来`);
    } else {
      state = { silent: false, since: 0, by: String(by || '') };
      log?.info(`退出潜水模式（${by || '他'}说的）：恢复正常说话`);
    }
    save();
    return state;
  }

  return {
    isSilent,
    set,
    snapshot: () => ({ ...state }),
    settings: opt,
    match: (text) => (opt.enabled === false ? null : matchModeCommand(text, opt)),
  };
}

module.exports = { MODE_DEFAULTS, createModeStore, matchModeCommand, normalizeCmd };
