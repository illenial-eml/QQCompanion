'use strict';
/**
 * 跨窗口连续性（P1-4，默认谨慎开启）
 *
 * 场景：主人在群里说完话，30 分钟内切到私聊找她 —— 她应该记得刚才那句。
 * 现实限制（隐私边界，写死在代码里）：
 *   1. 只记 **主人自己** 在 **群里** 说的话（别人的话一个字都不进）；
 *   2. 只保留 windowMinutes 分钟（默认 30）；
 *   3. 注入私聊时最多 maxChars 字（默认 200），且只在主人私聊里注入；
 *   4. 只读内存，不落盘 —— 机器人重启就清空，不留历史。
 *
 * 为什么默认开、但参数保守：他在群里说的话本来就对群里公开，私聊里提一句
 * 属于「同一个人记得刚才的事」，不是把群里的私货搬进私聊。
 */

const CROSS_DEFAULTS = {
  enabled: true,
  windowMinutes: 30,
  maxLines: 3,
  maxChars: 200,
  lineChars: 60,
};

function clean(line) {
  return String(line || '')
    .replace(/@\S+/g, '')
    .replace(/https?:\/\/\S+/g, '[链接]')
    .replace(/\s+/g, ' ')
    .trim();
}

function createCrossWindow({ cfg = {}, log = null, now = () => Date.now() } = {}) {
  const conf = { ...CROSS_DEFAULTS, ...(cfg || {}) };
  // userId -> [{ text, at, where }]
  const byUser = new Map();
  const MAX_KEEP = 30;

  function windowMs() {
    return Math.max(1, Number(conf.windowMinutes) || 30) * 60 * 1000;
  }

  /** 记录主人自己在群里说的一句（非主人、私聊、空话都不记） */
  function noteGroupLine({ userId, text, where = '', owner = false } = {}) {
    if (!conf.enabled) return false;
    if (!owner || !userId) return false;
    const id = String(userId);
    const t = clean(text);
    if (!t || t.length < 2) return false;
    if (/^\[图片\]|^\[表情\]|^\[语音\]/.test(t)) return false;
    const list = byUser.get(id) || [];
    const last = list[list.length - 1];
    if (last && last.text === t && now() - last.at < 60 * 1000) return false; // 复读不重复记
    list.push({ text: t.slice(0, Number(conf.lineChars) || 60), at: now(), where: String(where || '').slice(0, 20) });
    while (list.length > MAX_KEEP) list.shift();
    byUser.set(id, list);
    return true;
  }

  function recent({ userId, nowMs = now() } = {}) {
    if (!conf.enabled || !userId) return [];
    const list = byUser.get(String(userId)) || [];
    const from = nowMs - windowMs();
    return list.filter((x) => x.at >= from && x.at <= nowMs);
  }

  /** 私聊时调：返回注入给模型的一段话，没有就返回 '' */
  function contextFor({ userId, scene = 'c2c', nowMs = now() } = {}) {
    if (!conf.enabled) return '';
    if (scene !== 'c2c') return '';
    const lines = recent({ userId, nowMs });
    if (!lines.length) return '';
    const maxLines = Math.max(1, Number(conf.maxLines) || 3);
    const picked = lines.slice(-maxLines);
    const minutes = Math.max(1, Math.round((nowMs - picked[picked.length - 1].at) / 60000));
    const body = picked
      .map((x) => `${x.where ? x.where + '：' : ''}「${x.text}」`)
      .join('\n');
    let block =
      '## 刚才在群里\n' +
      `他 ${minutes} 分钟前在群里说过：\n${body}\n` +
      '你现在是在私聊里。如果这句跟现在聊的事有关，就自然接一下（别复述原话，别把群里别人的话拎出来）；无关就当没说过。';
    const cap = Math.max(80, Number(conf.maxChars) || 200);
    if (block.length > cap) block = block.slice(0, cap);
    return block;
  }

  /** 一键清空（主人说「忘了刚才群里」或交接时用） */
  function clear(userId) {
    if (userId) byUser.delete(String(userId));
    else byUser.clear();
  }

  function state() {
    return { enabled: !!conf.enabled, people: byUser.size, conf: { ...conf } };
  }

  return { noteGroupLine, recent, contextFor, clear, state, conf };
}

module.exports = { CROSS_DEFAULTS, createCrossWindow };
