'use strict';
/**
 * 「有人找你」——别人在找主人，或者来了一段她答不上来的东西，就私信提醒主人上号。
 *
 * 为什么要有：小号是「鸿」，不是主人本人。别人找「鸿」等于找主人、有事要谈；
 * 模型偶尔也会被问懵（答非所问那种）。这两种情况与其让她硬编一句，
 * 不如悄悄给主人手机发一条：「有人找你了，去上号」。
 *
 * 两类触发：
 *   1. 明确在找主人 —— 「我找火鸟」「你们主人在吗」「叫本人来」
 *   2. 觉得难回答   —— 模型回了 PASS / 回了「我不知道」/ 触发了答非所问关键词
 *
 * 防烦人：
 *   - 同一个窗口（私聊的那个人 / 那个群）冷却 notifyCooldownMinutes 内只发一次
 *   - 同一个人每天最多 notifyMaxPerDay 条
 *   - 每次只通知主人一个地方（私聊）
 */

const NOTIFY_DEFAULTS = {
  enabled: true,
  cooldownMinutes: 30, // 同一个窗口多久内不重复提醒
  maxPerDay: 6, // 每天最多提醒几次
  minIntervalMinutes: 10, // 两次提醒之间至少隔多久（全局）
};

function defaults(over = {}) {
  return { ...NOTIFY_DEFAULTS, ...(over || {}) };
}

/** 归一化：去空白、小写，方便关键词包含判断 */
function norm(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 判断「这句话是不是在找主人」。
 * 关键词故意写得口语，但不至于太宽（「你主人」这种带「主人」的容易误判，单独再收紧）。
 */
const FIND_OWNER_RULES = [
  // 直接点名主人
  /找(一下)?(火鸟|火鸟|eml|主人|本人|他|那个男的|真人)/i,
  /(火鸟|火鸟|eml|主人|本人)(在吗|在不在|呢|呢？|吗|？|\?)/i,
  // 「叫你来的人」「切到真人」这类
  /(叫|让|喊)(他|主人|火鸟|本人)?(本人)?(来|出来|过来|上线|上号)/i,
  /(真人|本人)(在|是)?(吗|么|不在|来)/i,
  /(你是机器人|你是ai|你是bot|你是假的)/i,
  /(转告|告诉你主人|帮你主人|跟你主人说|让你主人)/i,
  /你(主人|老板|背后的|后面那个)(是谁|在哪|叫什么)/i,
  // 需要主人亲自处理的事
  /(我要找|我有事找|想找你主人)/i,
];

function looksForOwner(text) {
  const t = norm(text);
  if (!t) return null;
  for (const re of FIND_OWNER_RULES) {
    const m = t.match(re);
    if (m) return m[0];
  }
  return null;
}

/**
 * 判断「她答得上来吗」。
 * 现在的做法不依赖模型自评（自评容易假阳性），而是看模型**实际表现**：
 *  PASS（没话说） / 空 / 明显的「我不知道」 / 答非所问的关键词。
 */
const DONT_KNOW_WORDS = [
  '不知道', '不清楚', '不太懂', '不懂', '没听说过', '不清楚诶', '我也不会',
  '答不上来', '说不好', '不太明白', '嗯…这个我',
];

// 模型把主人的私事揽到自己头上时的典型串（就是之前「我本来就是个对象」那种）
const SELF_POSITION_WORDS = ['本来就是个对象', '我就是个对象', '我是什么', '我就是个'];

// 模型「穿帮」时特有的开发/程序词（2026-10-28 那次回了
// 「This entity is not registered in `data/entities/k666.json`. Ask your maintainers...」
// 完整一段英文开发术语，跟聊天完全无关。命中就当成「她接不住」提醒主人。
const LEAK_WORDS = [
  'this entity is not registered',
  'ask your maintainers',
  'data/entities',
  'is not registered in',
  'not registered',
  'maintainers',
  'entity',
];

function looksStuck(replyText) {
  const r = norm(replyText);
  if (!r) return 'pass';
  if (r.length <= 4 && DONT_KNOW_WORDS.some((w) => r.includes(norm(w)))) return 'dont-know';
  if (DONT_KNOW_WORDS.some((w) => r.includes(norm(w)))) return 'dont-know';
  if (SELF_POSITION_WORDS.some((w) => r.includes(norm(w)))) return 'self-position';
  // 一整句英文、或者带了程序/开发术语 → 穿帮了，提醒主人来看看
  const ascii = r.replace(/[^\x20-\x7e]/g, '');
  if (ascii.length >= 40 && ascii.length / r.length > 0.8) return 'english-leak';
  if (LEAK_WORDS.some((w) => r.includes(norm(w)))) return 'dev-leak';
  return null;
}

/**
 * @param {object} o
 * @param {function} o.onNotify  async ({kind, reason, msg}) => void  真正去私信主人的地方
 */
function createNotifier({ cfg = {}, log = null, now = Date.now, onNotify = null } = {}) {
  const opts = defaults(cfg);
  const lastByWindow = new Map(); // window -> 上次提醒时间
  const countByWho = new Map(); // who -> { day, n }
  let day = new Date(now()).toISOString().slice(0, 10);
  let lastAt = 0;

  function rollDay() {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      countByWho.clear();
    }
  }

  /**
   * 试一次提醒。返回 true = 真发了，false = 被防刷挡了。
   */
  async function maybe({ kind, reason, msg, window, who }) {
    if (opts.enabled === false) return false;
    rollDay();
    const t = now();
    if (lastAt && t - lastAt < Number(opts.minIntervalMinutes) * 60000) {
      log?.debug?.(`[有人找] 刚提醒过（${Math.round((t - lastAt) / 60000)} 分钟前），这次先忍着：`, reason);
      return false;
    }
    const w = String(window || '');
    const last = lastByWindow.get(w) || 0;
    if (last && t - last < Number(opts.cooldownMinutes) * 60000) {
      log?.debug?.(`[有人找] 这个对象刚提醒过，不重复：`, reason);
      return false;
    }
    const key = String(who || w || '?');
    const c = countByWho.get(key) || { day, n: 0 };
    if (c.n >= Number(opts.maxPerDay)) {
      log?.debug?.(`[有人找] 今天给 ${key} 提醒够次数了（${c.n}）`);
      return false;
    }
    c.n += 1;
    countByWho.set(key, c);
    lastByWindow.set(w, t);
    lastAt = t;
    log?.info?.(`[有人找] 私信主人上号（${kind === 'find' ? '别人找你' : '我答不上来'}）：${reason}`);
    if (onNotify) {
      try {
        await onNotify({ kind, reason, msg });
      } catch (e) {
        log?.warn?.('[有人找] 通知主人失败:', e.message);
      }
    }
    return true;
  }

  return { settings: opts, maybe, looksForOwner, looksStuck, _reset: () => { lastByWindow.clear(); countByWho.clear(); lastAt = 0; } };
}

module.exports = {
  NOTIFY_DEFAULTS,
  FIND_OWNER_RULES,
  DONT_KNOW_WORDS,
  SELF_POSITION_WORDS,
  looksForOwner,
  looksStuck,
  createNotifier,
};
