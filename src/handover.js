'use strict';
/**
 * 「手动接管」：你要自己用小号聊的时候说一句「我上」，它就把嘴闭上（消息照记不回复）；
 * 你聊完说「你上」，它再接手。
 *
 * 为什么需要：OneBot 事件里自己发的消息（self_id）会被适配器过滤掉，
 * 所以「你亲自用小号说话」这件事它根本看不到，必须靠一句口令显式交接。
 *
 * 状态落盘到 data/handover.json，重启后依然有效（不会因为重启又把嘴张开）。
 */
const fs = require('fs');
const path = require('path');

const HANDOVER_DEFAULTS = {
  enabled: true,
  // 接管：你来说（只有主人说得动）
  takeOverCommands: ['我上', '我上了', '我上号', '换我', '换我上', '我来', '我自己来', '我接管'],
  // 交回：你说这句，它重新说话
  releaseCommands: ['你上', '你上了', '你上号', '交给你', '你来', '你接管', '我下了', '我下'],
  takeOverReply: '好，我闭嘴，你聊。',
  releaseReply: '那我来了。',
  // 防「说了我上就忘了」：接管最多持续多少分钟，到点自动交回（0 = 永不过期）
  // 用户要求（2026-10-28）：「暂时不要定时下线人工给接管，我不说她就一直在」→ 默认 0（永不过期）
  autoReleaseMinutes: 0,
};

/** 去噪：去掉 @xx、空格、标点，只留下「我上」这种纯口令 */
function normalizeCmd(text) {
  return String(text || '')
    .replace(/@\S+/g, '')
    .replace(/^[\/／]+/, '')
    .replace(/[\s，。！？!?,.、~～:：;；"'“”‘’()（）]+/g, '')
    .trim();
}

/**
 * 认接管口令。返回 'takeover' | 'release' | null
 */
function matchHandoverCommand(text, cfg = HANDOVER_DEFAULTS) {
  const opts = { ...HANDOVER_DEFAULTS, ...cfg };
  if (opts.enabled === false) return null;
  const t = normalizeCmd(text);
  if (!t) return null;
  const eq = (c) => t === normalizeCmd(c);
  if ((opts.releaseCommands || []).some(eq)) return 'release';
  if ((opts.takeOverCommands || []).some(eq)) return 'takeover';
  return null;
}

/**
 * @param {object} o
 * @param {string|null} o.file  落盘路径（data/handover.json）
 * @param {object} o.cfg        config.modes.handover
 */
function createHandoverStore({ file = null, cfg = {}, log = null, now = Date.now } = {}) {
  const opts = { ...HANDOVER_DEFAULTS, ...cfg };
  let state = { active: false, since: 0, by: '' };

  if (file) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        state = {
          active: raw.active === true,
          since: Number(raw.since) || 0,
          by: String(raw.by || ''),
        };
      }
    } catch (e) {
      log?.warn?.('接管状态读取失败，当作「它上」:', e.message);
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date(now()).toISOString() }, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (e) {
      log?.warn?.('接管状态保存失败:', e.message);
    }
  }

  return {
    settings: opts,
    isActive,
    since: () => state.since,
    by: () => state.by,
    /** 切状态。active=true 表示「你上」（它闭嘴） */
    set(active, { by = '' } = {}) {
      state = { active: active === true, since: active ? now() : 0, by: String(by || '') };
      save();
      log?.info?.(
        `[接管] ${state.active ? '切到「你上」：它闭嘴，你自己用小号聊' : '切回「它上」：它重新说话'}${by ? `（${by}）` : ''}`
      );
      return state;
    },
  };

  /**
   * 现在是不是「你接管中」。
   *
   * 曾经加过自动超时（怕你说了「我上」忘了说「你上」，它一直闭嘴让你以为「机器人坏了」）。
   * 但用户明确要求（2026-10-28）：「暂时不要定时下线人工给接管，我不说她就一直在」
   * → autoReleaseMinutes 默认改成 0（永不过期）。想恢复就把它设成正数。
   */
  function isActive() {
    if (state.active !== true) return false;
    const maxMin = Number(opts.autoReleaseMinutes) || 0;
    if (maxMin > 0 && state.since > 0 && now() - state.since > maxMin * 60000) {
      const mins = Math.round((now() - state.since) / 60000);
      state = { active: false, since: 0, by: '' };
      save();
      log?.info?.(`[接管] 你接管了 ${mins} 分钟没说「你上」，自动交回给它了`);
      return false;
    }
    return true;
  }
}

module.exports = { HANDOVER_DEFAULTS, matchHandoverCommand, normalizeCmd, createHandoverStore };
