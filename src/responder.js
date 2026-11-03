'use strict';
/**
 * 消息处理核心：收到一条 QQ 消息 -> 问大脑 -> 回出去。
 * 与 QQ 传输层解耦（bot 只要实现 sendC2C / sendGroup），方便离线测试。
 *
 * 官方限制（保守取值）：
 *   单聊被动回复：5 分钟内、同一 msg_id 最多 4 条
 *   群聊被动回复：5 分钟内、同一 msg_id 最多 5 条
 *   超出后改用「主动消息」（有独立频控，`-ErrorCode 40034100` 即被限流）
 */
const fs = require('fs');
const path = require('path');
const { RHYTHM_DEFAULTS, splitBubbles, bubbleDelays } = require('./rhythm');
const { extractSticker } = require('./stickers');
const { detectHostile } = require('./hostile');
const { parseReminder, fmt, fmtIn, isReminderRequest } = require('./reminders');
const { looksForOwner, looksStuck } = require('./notify-owner');
const { matchHandoverCommand } = require('./handover');

const PASSIVE_LIMIT = { c2c: 4, group: 5 };

/** 热度分桶：桶跨度 1 分钟；两个桶时间差不超过这么多分钟就当作「连续的桶」 */
const HEAT_KEEP_MIN = 1;

/** 「一小时发了多少次」用定长环形缓冲：容量 = 每小时上限，满了就覆盖最旧的（O(1)） */
const HOUR_RING_CAP = 200;

/**
 * 定长环形缓冲写入：满了就覆盖最旧的，不搬数据。
 * 用于「最近一小时发言时间戳」这种只看固定上限的记录。
 */
function pushBounded(arr, value, cap) {
  arr.push(value);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  return arr;
}

/** 丢掉超出窗口的时间戳（只可能发生在最前面，所以是 O(被丢掉的条数)） */
function pruneStamps(st, nowMs, winMs) {
  const stamps = st.stamps;
  let i = 0;
  while (i < stamps.length && nowMs - stamps[i] >= winMs) i += 1;
  if (i > 0) stamps.splice(0, i);
  return stamps;
}

/** 群里记忆里记自己说的话时用的名字（一般和 QQ 里显示的机器人名一致） */
const BOT_NAME = '小D';

/** 群聊自主回复的默认值（config.json 里的 qq.groupAuto 覆盖这里） */
const GROUP_AUTO_DEFAULTS = {
  enabled: false,
  // 默认不接：只有被 @ / 叫名字 / 命中 keywords 才接话。
  // 想让它偶尔自己插一句，把 mode 改成 'smart'。
  mode: 'keywords',     // keywords | smart | always
  keywords: ['水鸡', '肥鱼'],
  minIntervalSec: 120,
  maxPerHour: 12,
  hotBypass: false,     // 热闹时也不插队（之前开着，插话太勤）
  staleSkipMs: 7000,    // 排队太久才轮到的消息就不回了，免得答已经聊过去的话题
  passiveAfterSec: 45,  // 没被 @ 时，群里安静超过这么久才允许她主动补一句（有人正在聊就让位）
  contextSize: 12,
  reactWithSticker: true,
  reactMinIntervalSec: 300,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 群里「主动答题」的默认值（config.json 里的 qq.groupAnswer 覆盖这里） */
const GROUP_ANSWER_DEFAULTS = {
  enabled: true,
  atQuestioner: false,  // 回答时要不要 @ 提问的人。默认不 @（QQ 群不认 <@openid>，会把一串代码原样显示出来）
  hotReplies: 3,        // 别人已经回过几条，就算「很多人回过了」
  coldSeconds: 180,     // 问题挂了多久没人回，算冷场
  cooldownSec: 300,     // 同一个群两次主动答题的最小间隔
  maxPerHour: 6,        // 同一个群每小时最多主动答几次
  minChars: 6,          // 太短的不算正经问题
  tickSec: 30,
};

/** 群里「自己开话题」的默认值（config.json 里的 qq.groupTopic 覆盖这里）
 *  用户反馈：之前它总去接一个旧问题，答复重复、还找错人。改成「安静一阵后自己起个话头」。 */
const GROUP_TOPIC_DEFAULTS = {
  enabled: true,
  idleMinutes: 25,     // 群里安静多久算冷场，可以自己开口
  minGapMinutes: 45,   // 同一个群两次主动开话题的最小间隔
  maxPerDay: 6,        // 同一个群每天最多开几次
  minMessages: 3,      // 至少见过几句聊天，才知道该聊什么
  quietHours: [0, 1, 2, 3, 4, 5, 6, 7], // 半夜别开话题（北京时间）
  dupWindowMinutes: 40, // 这么久的窗口内说过几乎一样的话就不再发
  /**
   * 按时段微调（北京时间）：不同时间「该不该主动开口」差别很大——
   * 中午群里大家都在刷屏，硬开话题很突兀；晚上人散了、情绪多，反而适合聊。
   *
   * 每项：{ start, end, idleMinutes?, minGapMinutes?, maxPerDay? }
   *   start/end 是小时（含 start、不含 end），跨越 0 点就写 start>end。
   *   命中的那一项会覆盖上面的全局值（没写的字段保持全局）。
   * 想关掉时段微调：把 timeWindows 设成 []。
   */
  timeWindows: [
    // 早上：刚起床，别急着搭话
    { start: 8, end: 11, idleMinutes: 40, maxPerDay: 2 },
    // 中午饭点：群里可能正热闹，让位给真人
    { start: 11, end: 14, idleMinutes: 35, maxPerDay: 1 },
    // 下午茶 / 摸鱼：可以聊
    { start: 14, end: 18, idleMinutes: 25, maxPerDay: 4 },
    // 晚上：最活跃的时候，话可以多一点
    { start: 18, end: 24, idleMinutes: 20, minGapMinutes: 35, maxPerDay: 8 },
  ],
};

/**
 * 按北京时间小时取「这个时段生效的参数」。
 * 支持跨越 0 点的窗口（start > end，比如 {start:22, end:2}）。
 */
function windowForHour(windows, hour) {
  if (!Array.isArray(windows)) return null;
  for (const w of windows) {
    if (!w || typeof w !== 'object') continue;
    const s = Number(w.start);
    const e = Number(w.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    const hit = s <= e ? hour >= s && hour < e : hour >= s || hour < e;
    if (hit) return w;
  }
  return null;
}

/** 把时段覆盖合并到基础参数上（只覆盖写了的那几个字段） */
function topicParamsAt(groupTopic, hour) {
  const w = windowForHour(groupTopic.timeWindows, hour);
  if (!w) return groupTopic;
  const out = { ...groupTopic };
  for (const k of ['idleMinutes', 'minGapMinutes', 'maxPerDay']) {
    if (Number.isFinite(Number(w[k]))) out[k] = Number(w[k]);
  }
  return out;
}

/** 两个短句像不像（字符二元组重合度），用来挡「重复说同一句话」 */
function simText(a, b) {
  const x = String(a || '').replace(/[\s\p{P}]/gu, '');
  const y = String(b || '').replace(/[\s\p{P}]/gu, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(x); const gb = grams(y);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return (2 * hit) / (ga.size + gb.size);
}

/** 这句话是不是在问别人（@ 了不在 botNames 里的人）——那种问题别抢答 */
function asksSomeoneElse(text, botNames = []) {
  const ats = String(text || '').match(/@[^\s@]{1,12}/g) || [];
  if (!ats.length) return false;
  const names = (botNames || []).filter(Boolean);
  return ats.some((a) => {
    const n = a.slice(1);
    return !names.some((b) => n.includes(b) || b.includes(n));
  });
}

/** 看着像不像「正经提问」：问号结尾，或者带疑问词/求助词 */
const QUESTION_RE = /(怎么|怎样|咋|为什么|为啥|如何|哪里|哪个|哪些|谁|能不能|可不可以|是不是|有没有|要不要|教教我|教我|求个?帮助|求助|报错|怎么办|咋办|啥情况|请问|大佬|有人知道|有人会)/;

function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/[？?]\s*$/.test(t)) return true;
  return QUESTION_RE.test(t);
}

/** 学会新表情时的回复（短、像人） */
const LEARN_ACK_LINES = ['这表情我收了', '收了，回头我也用', '嗯，这个存下了'];

/** 「嗯」「啊」「哈哈」这类没信息量的短句：群里不值得为它调一次模型（慢又费钱） */
function isTrivialChatter(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const stripped = t.replace(/[\s。，,.!?！？~～…、;；:：]/g, '');
  if (!stripped) return true;
  if (stripped.length <= 1) return true;
  if (stripped.length <= 4 && /^(嗯+|啊+|哦+|噢+|哈+|嘿+|呵+|额+|诶+|唉+|好+|行+|ok|OK|在|在吗)$/.test(stripped)) return true;
  return false;
}

/**
 * 模型偶尔会在中文里加空格、把时间拆成「10:3 0」，发出来就是乱的。
 * 这里统一修：数字之间、中文之间的空格去掉，冒号两边不留空格。
 */
function normalizeReply(text) {
  let t = String(text || '');
  t = t.replace(/(\d)\s*([:：])\s*(\d)/g, '$1:$3');   // 10 : 30 -> 10:30
  t = t.replace(/(\d)\s+(?=\d)/g, '$1');              // 10:3 0 -> 10:30
  t = t.replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1'); // 中文之间不留空格
  t = t.replace(/([\u4e00-\u9fa5])\s+(?=[0-9])/g, '$1');           // 中文和数字之间不留空格
  t = t.replace(/([0-9])\s+(?=[\u4e00-\u9fa5])/g, '$1');           // 数字和中文之间不留空格
  // 半角标点转全角（只在挨着中文时才转，避免破坏 10:30、1,000 这种）
  const CN = /[\u4e00-\u9fa5]/;
  const HALF2FULL = { ',': '，', ';': '；', ':': '：', '!': '！', '?': '？' };
  t = t.replace(/[,;:!?]/g, (m, off, s) => {
    const prev = s[off - 1] || '';
    const next = s[off + 1] || '';
    if (!CN.test(prev) && !CN.test(next)) return m;
    return HALF2FULL[m] || m;
  });
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/** 按长度切分长回复，尽量在换行/标点处断开 */
// 他平时一条消息就一小句（624 条里 78% 在 10 字以内、中位 6 字）。
// 模型偶尔会写成一长串一行到底的话，这里把它切成一行一句：
// 先按换行分块，每块再按句末标点断句，过长的句子再按逗号切开。
function breakNatural(text, maxLen = 15) {
  const raw = String(text || '').trim();
  if (!raw) return raw;

  const cutLine = (line) => {
    const l = line.trim();
    if (!l) return [];
    const sents = l.split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
    const out = [];
    for (const sent of sents) {
      if (sent.length <= maxLen) { out.push(sent); continue; }
      const parts = sent.split(/(?<=[，,；;])/).map((x) => x.trim()).filter(Boolean);
      if (parts.length <= 1) { out.push(sent); continue; }
      let cur = '';
      for (const part of parts) {
        if (!cur) { cur = part; continue; }
        if ((cur + part).length <= maxLen) { cur += part; continue; }
        out.push(cur);
        cur = part;
      }
      if (cur) out.push(cur);
    }
    return out;
  };

  const lines = [];
  for (const block of raw.split(/\n+/)) lines.push(...cutLine(block));

  // 每行末尾的标点去掉（他自己发消息末尾从来不带标点）
  const cleaned = lines.map((l) => l.replace(/[。，,、；;：:]$/, '').trim()).filter(Boolean);
  return cleaned.length ? cleaned.join('\n') : raw;
}

function splitReply(text, max) {
  const chunks = [];
  let rest = String(text || '').trim();
  // 断点优先落在句末，其次才是逗号；别把「，」当成一段的结尾发出去
  const STRONG = '。！？!?…\n';
  const WEAK = '，,、；;：:';
  while (rest.length > max) {
    let cut = -1;
    for (let i = Math.min(max, rest.length - 1); i > max * 0.4; i--) {
      if (STRONG.includes(rest[i])) { cut = i; break; }
    }
    if (cut < 0) {
      for (let i = Math.min(max, rest.length - 1); i > max * 0.6; i--) {
        if (WEAK.includes(rest[i])) { cut = i; break; }
      }
    }
    if (cut < 0) cut = max - 1; // 实在没有标点，硬切也别切在 max 之外
    const piece = rest.slice(0, cut + 1).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  // 兜底：一小段纯文字一个标点都没有，读起来就是一串字，末尾补个句号
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.length >= 25 && !/[。！？!?…，,、；;：:\n]/.test(c)) chunks[i] = c + '。';
  }
  return chunks;
}

function createResponder({
  cfg, bot, brain, log, memoryStore = null,
  sleepFn = sleep, rng = Math.random,   // 测试时注入，用来跳过真实等待
  stickers = null,                      // { list, service } —— 表情包目录 + 发送器
  learner = null,                       // 表情包学习器（别人发的图自动存下来）
  groupLog = null,                      // 群聊日志（私聊里能问「群里聊啥了」）
  ownerStore = null,                    // 认主人（群里他说的话一律听）
  modeStore = null,                     // 潜水模式（他说「潜水」就闭嘴，只说「浮上来」才恢复）
  groupScope = null,                    // 群消息范围检测（只推 @ 的群，私聊里提醒他去开全量）
  groupNames = null,                    // 群名记录（群1 = 「bio人能飞」这种，让人看得懂）
  visionSvc = null,                     // 看图（下载图片 → 塞给模型）
  searchSvc = null,                     // 联网搜索（查它没听过的东西）
  handoverStore = null,                 // 手动接管（我说「我上」它就让位，说「你上」还给它）
  reminderStore = null,                 // 日程提醒（只认主人的私聊）
  notifySvc = null,                     // 「有人找你」：别人找主人 / 她答不上来 → 私信提醒主人上号
  emojiLiker = null,                    // 贴表情（NapCat 的 set_msg_emoji_like）
}) {
  const groupAuto = { ...GROUP_AUTO_DEFAULTS, ...(cfg.qq.groupAuto || {}) };
  const groupAnswer = { ...GROUP_ANSWER_DEFAULTS, ...(cfg.qq.groupAnswer || {}) };
  const groupTopic = { ...GROUP_TOPIC_DEFAULTS, ...(cfg.qq.groupTopic || {}) };
  const rhythm = { ...RHYTHM_DEFAULTS, ...(cfg.rhythm || {}) };
  const stickerList = stickers?.list || [];
  const stickerSvc = stickers?.service || null;
  const groups = new Map(); // groupId -> { lines, lastAt, stamps, buckets, botStreak }

  /**
   * 群热度：按分钟分桶 + 滑动窗口（把「按分钟分桶 + 滑动窗口」从说法变成代码）
   *
   * 老写法每来一条消息、每次判断都要对整条说话记录做 filter：
   *   st.speakers = st.speakers.filter(...)   // 每次 O(n)
   * 现在改成：
   *   - 每条消息只往「当前这一分钟」的桶里 +1          → 更新 O(1)
   *   - 查询时只看窗口覆盖的那几个桶再把它们加起来      → O(窗口分钟数)，与历史条数无关
   * 连续发很多条消息，历史记录也不会无限变长（只保留窗口 + 1 分钟）。
   */
  const heat = {
    add(st, who, at) {
      const mi = Math.floor(at / 60000);
      const last = st.buckets[st.buckets.length - 1];
      let b;
      if (last && mi - last.t <= HEAT_KEEP_MIN) {
        // 同一个桶（或者中间空了几分钟）就往前推：把空出来的分钟补成空桶，保持下标可算
        while (last.t < mi) {
          last.t += 1;
          st.buckets.push({ t: last.t, who: new Map(), n: 0 });
        }
        b = st.buckets[st.buckets.length - 1];
      } else {
        // 隔太久了，旧桶全没用，直接重建
        st.buckets = [{ t: mi, who: new Map(), n: 0 }];
        b = st.buckets[0];
      }
      b.who.set(who, (b.who.get(who) || 0) + 1);
      b.n += 1;
      st.bucketAt = at;
      // 只留窗口内的桶，别让数组无限长
      const keepMs = (groupAuto.hotWindowSec ?? 60) * 1000;
      const cutoff = mi - Math.ceil(keepMs / 60000) - 1;
      while (st.buckets.length && st.buckets[0].t < cutoff) st.buckets.shift();
      return b;
    },
    query(st, nowMs, winMs) {
      if (!st.buckets.length) return { people: 0, messages: 0 };
      // 这条消息如果是「上一分钟」的，now 可能略微落后于它；用两者较大的那个
      const now = Math.max(nowMs, st.bucketAt);
      const from = Math.floor((now - winMs) / 60000);
      const to = Math.floor(now / 60000);
      const who = new Map();
      let n = 0;
      for (let i = st.buckets.length - 1; i >= 0; i -= 1) {
        const b = st.buckets[i];
        if (b.t > to) continue;
        if (b.t < from) break;
        n += b.n;
        for (const [w, c] of b.who) who.set(w, (who.get(w) || 0) + c);
      }
      return { people: who.size, messages: n };
    },
  };
  // 连着几条没发表情了就提醒模型一句（表情包要「用起来」，不然存着也是白存）
  let repliesSinceSticker = 0;

  function gstate(groupId) {
    let st = groups.get(groupId);
    if (!st) {
      st = {
        lines: [], lastAt: 0, stamps: [], botStreak: 0, lastReactAt: 0,
        buckets: [],       // 热度分桶：每项 { t: 分钟序号, who: Map<名字, 条数>, n: 条数 }
        bucketAt: 0,       // buckets 里最新一桶的绝对时间（0 = 还没有）
        stampAt: 0,        // stamps 里最新一次发言的时间（环形缓冲用）
        pending: null,     // 群里待解决的一个问题（谁问的、问的什么、几个人回过）
        answerStamps: [],  // 主动答题的时间戳（每小时的额度）
        botLines: [],      // 自己最近说过的话（挡重复）
        lastTopicAt: 0,    // 上次主动开话题的时间
        topicDay: '',      // 「今天」是哪天（按北京时间算）
        topicCount: 0,     // 今天开了几次话题
      };
      groups.set(groupId, st);
    }
    return st;
  }

  /**
   * 群里显示用的名字：优先用你教过的真群名，其次用「群1」这种编号，最后才用 openid 前 8 位。
   */
  function groupDisplayName(groupId) {
    if (!groupId) return '某个群';
    const named = groupNames?.nameOf?.(groupId);
    if (named) return named;
    const label = groupLog?.labelOf?.(groupId);
    if (label) return label;
    return `群${String(groupId).slice(0, 8)}`;
  }

  function rememberLine(groupId, who, text) {
    const st = gstate(groupId);
    st.lines.push(`${who || '有人'}：${text}`);
    const keep = Math.max(20, groupAuto.contextSize * 2);
    if (st.lines.length > keep) st.lines = st.lines.slice(-keep);
    // 记「谁在什么时候说话」，用来判断群里是不是正聊得热闹（热闹时允许插话）
    // 注意：自己说的话不算「热闹」，否则会误以为自己插得很活跃
    if ((who || '') !== BOT_NAME) {
      st.lastMsgAt = Date.now();  // 群里最后一次有人说话（判断「有没有冷场」用，和 bot 说话的 lastAt 分开）
      heat.add(st, who || '有人', st.lastMsgAt);
      // 插过一次话之后别人紧接着继续聊，仍算「我在连着插」；隔久了（默认 20 秒）才算新一轮
      const gap = Date.now() - st.lastAt;
      if (gap > (groupAuto.streakResetSec ?? 20) * 1000) st.botStreak = 0;
    }
  }

  /** 群里的热闹程度：最近 hotWindowSec 内有多少人、多少条（窗口内每分钟一个桶，更新 O(1)，查询 O(窗口分钟数)） */
  function groupHeat(st) {
    return heat.query(st, Date.now(), (groupAuto.hotWindowSec ?? 60) * 1000);
  }

  /** 群聊被动接话的分层：热闹时让位、冷场才补话、被叫到才直答
   *  为什么这么分：之前只要命中关键词就往里插，结果群里正聊得热火朝天她也接一句，
   *  显得「硬凑话」。现在改成三档——被 @ 直回；有人接走的话（别人在互相聊）不插；
   *  只有群真冷下来（passiveAfterSec 内没人说话）才主动补一句。
   */
  function groupBudget(groupId) {
    const st = gstate(groupId);
    const now = Date.now();
    pruneStamps(st, now, 3600 * 1000);
    if (st.stamps.length >= groupAuto.maxPerHour) return 'group-hourly-cap';

    // 发言节奏自适应（2026-10-28）：群里越热闹，她越该少说话——一是别刷屏，二是
    // 小号被风控盯过（3 轮实名），发言越密越容易被当成机器人。
    if (groupAuto.adaptiveRate !== false) {
      const h = groupHeat(st);
      const hotCap = Number(groupAuto.hotMaxPerHour ?? 3);
      const veryHot =
        h.people >= (groupAuto.hotMinSpeakers ?? 2) + 1 &&
        h.messages >= (groupAuto.hotMinMessages ?? 3) * 2;
      if (veryHot && st.stamps.length >= hotCap) return 'group-hot-cap';
    }

    const since = now - st.lastAt;
    const cooldownMs = (groupAuto.minIntervalSec ?? 20) * 1000;
    if (since < cooldownMs) {
      // 群里正聊得热闹时，允许提前插一句（真人也是这么插话的）
      const h = groupHeat(st);
      const hot =
        groupAuto.hotBypass !== false &&
        h.people >= (groupAuto.hotMinSpeakers ?? 2) &&
        h.messages >= (groupAuto.hotMinMessages ?? 3);
      if (!hot) return 'group-cooldown';
    }

    // 刚连着说了几句还没人回，就先闭嘴（别自己跟自己聊起来）
    const maxStreak = groupAuto.maxConsecutive ?? 2;
    if (st.botStreak >= maxStreak) return 'group-streak';
    return null;
  }

  /** 不 @ 的情况下，现在插嘴合不合适：热闹就让位，冷场才接 */
  function passiveTiming(groupId) {
    const st = gstate(groupId);
    const now = Date.now();
    const quietMs = (Number(groupAuto.passiveAfterSec) || 0) * 1000;
    if (quietMs > 0 && st.lastMsgAt) {
      const silent = now - st.lastMsgAt;
      // 别人刚说完（比如正在一来一回地聊），这时候插嘴就是硬凑
      if (silent < quietMs) {
        const h = groupHeat(st);
        return { ok: false, reason: 'group-busy', silent, people: h.people, messages: h.messages };
      }
    }
    return { ok: true };
  }

  function markSpoke(groupId) {
    const st = gstate(groupId);
    st.lastAt = Date.now();
    st.stampAt = st.lastAt;
    pushBounded(st.stamps, st.stampAt, HOUR_RING_CAP);
    st.botStreak += 1;
  }

  /**
   * 主动答题的预算：同一个群最多每小时 maxPerHour 次、两次之间至少隔 cooldownSec。
   * 返回 null 表示可以答，否则返回原因。
   */
  function answerBudget(st) {
    const now = Date.now();
    st.answerStamps = (st.answerStamps || []).filter((t) => now - t < 3600 * 1000);
    if (st.answerStamps.length >= (groupAnswer.maxPerHour ?? 6)) return 'answer-hourly-cap';
    const last = st.answerStamps[st.answerStamps.length - 1] || 0;
    if (last && now - last < (groupAnswer.cooldownSec ?? 300) * 1000) return 'answer-cooldown';
    return null;
  }

  /**
   * 答题时要不要在开头 @ 提问的人。
   * 默认不 @：QQ 群聊接口不认 `<@openid>` 这种语法，会原样把一串代码显示出来（实测踩过），
   * 所以干脆只回答、不 @ 。想强行 @ 就把 config.json 的 qq.groupAnswer.atQuestioner 改 true。
   */
  function atPrefixFor(pending) {
    if (groupAnswer.atQuestioner !== true || !pending) return '';
    return pending.by ? `@${pending.by} ` : '';
  }

  /**
   * 「贴表情」的近似：QQ 官方的表情表态（给消息加 reaction）只支持频道，
   * 单聊/群聊没有接口。所以这里退一步——它想了想不想接话时，干脆发一个小表情图，
   * 视觉上就等于在被回复的那条消息下面贴了个表情。
   * 返回 null 表示可以贴，否则返回原因。
   */
  function reactBudget(msg) {
    if (groupAuto.reactWithSticker === false) return 'react-off';
    if (!stickerSvc || !stickerList.length || cfg.sticker?.enabled === false) return 'react-no-sticker';
    const st = gstate(msg.groupId);
    const gap = (groupAuto.reactMinIntervalSec ?? 300) * 1000;
    if (st.lastReactAt && Date.now() - st.lastReactAt < gap) return 'react-cooldown';
    if (!stickerSvc.canSend(stickerSvc.sessionKey(msg))) return 'react-cooldown';
    return null;
  }

  /**
   * 群聊里「没 @ 我」的消息要不要接：
   *   返回 { allowPass } —— allowPass=true 表示让模型自己决定（它会用 PASS 表示不说话）
   *   mode: smart 让模型判断；keywords 命中才接；always 每条都接
   */
  function joinPolicy(msg, text) {
    const mode = String(groupAuto.mode || 'smart').toLowerCase();
    if (mode === 'always') return { allowPass: false };

    if (mode === 'keywords') {
      const kws = (groupAuto.keywords || []).filter(Boolean);
      if (kws.length) return kws.some((k) => text.includes(k)) ? { allowPass: false } : null;
      log?.warn?.('qq.groupAuto.mode=keywords 但 keywords 是空的，改用 smart 的判断方式');
    }
    return { allowPass: true };
  }

  /**
   * 贴表情：给「对方那条消息」点一个小黄脸（NapCat 的 set_msg_emoji_like）。
   * 和发表情图片不是一回事——贴表情是挂在消息下面的 reaction，更像人在点。
   * 返回 { name } 或 null。
   */
  function emojiSession(msg) {
    return msg.scene === 'group' ? `g:${msg.groupId}` : `u:${msg.userId}`;
  }
  async function tryEmojiLike(msg, tone, { probability = null, force = false } = {}) {
    if (!emojiLiker || !msg?.msgId) return null;
    try {
      const r = await emojiLiker.like(msg.msgId, {
        tone, sessionKey: emojiSession(msg), probability, force,
      });
      if (r && r.ok) return r;
      if (r && r.reason && r.reason !== 'emoji-skip') log?.debug?.(`没贴成表情：${r.reason}`);
      return null;
    } catch (e) {
      log?.debug?.(`贴表情抛错：${e.message}`);
      return null;
    }
  }

  function groupAllowed(msg) {
    const list = cfg.qq.allowGroups || [];
    return !list.length || list.includes(msg.groupId);
  }

  async function send(msg, content, seq, { passive = true } = {}) {
    const opts = { msgId: passive ? msg.msgId : undefined, msgSeq: seq, passive };
    if (msg.scene === 'c2c') return bot.sendC2C(msg.userId, content, opts);
    return bot.sendGroup(msg.groupId, content, opts);
  }

  /**
   * 潜水期间的群聊小结：从群聊日志里取出这段时间的清单，再让模型压成几句人话。
   * 返回 '' 表示这段时间群里没什么可说的。
   */
  async function buildSilentSummary({ since = 0, hours } = {}) {
    if (!groupLog) return '';
    const span = since ? (Date.now() - since) / 3600000 : 0;
    const useHours = hours || Math.min(24, Math.max(1, Math.ceil(span || (modeStore?.settings?.summaryHours ?? 8))));
    const digest = groupLog.digest({
      botName: BOT_NAME,
      selfNames: ownerStore ? ownerStore.names() : [],
      hours: useHours,
      perGroup: 10,
      maxGroups: modeStore?.settings?.summaryMaxGroups ?? 4,
      nameOf: (gid) => groupNames?.nameOf?.(gid) || '',
    });
    if (!digest) return '';
    try {
      return await brain.summarizeGroupDigest({ digest, hours: useHours });
    } catch (e) {
      log?.warn?.('潜水小结生成失败:', e.message);
      return '';
    }
  }

  /**
   * 私聊发一条给主人（用于「群里说的命令，结果要私发」这种场景）。
   * 先试互动召回（is_wakeup，官方给的正规主动开口通道），失败再普通主动消息。
   * 返回 true 表示发出去了。
   */
  async function sendPrivateToOwner(text, { seq = 1 } = {}) {
    const to = (cfg.qq.ownerIds || [])[0];
    if (!to) {
      log?.warn?.('没配 qq.ownerIds，没法私发给你');
      return false;
    }
    if (!text) return false;
    const tries = [
      { isWakeup: true, passive: false },
      { isWakeup: false, passive: false },
    ];
    for (const t of tries) {
      try {
        await bot.sendC2C(to, text, { msgSeq: seq, passive: t.passive, isWakeup: t.isWakeup });
        log?.info(`已私发给你（${t.isWakeup ? '互动召回' : '主动消息'}）：${text.slice(0, 20)}…`);
        return true;
      } catch (e) {
        log?.warn?.(`私发失败（${t.isWakeup ? '互动召回' : '主动消息'}）：`, e.errCode || '', e.message);
      }
    }
    return false;
  }

  // ================= 戳一戳（拍一拍） =================

  const pokeCfg = {
    enabled: true,          // 收到戳一戳要不要理
    pokeBack: true,         // 要不要戳回去（官方若没这个接口会自动退化成说话）
    minIntervalSec: 5,      // 同一个会话多久内只理一次，防连戳刷屏
    useModel: false,        // true = 让模型想一句回应（多花一次调用）
    replyTexts: [],         // 自定义回话模板，留空用内置的
    replyWithSticker: false,// 只回一个表情图，不写字
    typingFallback: true,   // 戳不回去时，单聊用「正在输入」示意一下（官方唯一接近的轻互动）
    ...(cfg.qq?.poke || {}),
  };
  const POKE_LINES_C2C = ['干嘛戳我。', '戳我干嘛，说事。', '别戳，我在。', '戳一下就行了啊。'];
  const POKE_LINES_GROUP = ['别戳我。', '戳我有事说事。', '谁在戳我。', '戳没用，说话。'];
  const pokeLastAt = new Map(); // `${scene}:${会话 id}` -> 时间戳
  const pokeNotSupported = { warned: false };

  /** 把一条文字发到戳一戳的来源会话：有 msg_id 就走被动回复，没有就试着主动发 */
  async function sendToPokeTarget(poke, text) {
    const opts = { msgSeq: 1 };
    if (poke.msgId) {
      opts.msgId = poke.msgId;
      opts.passive = true;
    }
    const tries = poke.msgId
      ? [{ passive: true, isWakeup: false }]
      : [{ passive: false, isWakeup: true }, { passive: false, isWakeup: false }];
    for (const t of tries) {
      try {
        if (poke.scene === 'group') {
          await bot.sendGroup(poke.groupId, text, { ...opts, msgId: t.passive ? poke.msgId : undefined });
        } else {
          await bot.sendC2C(poke.userId, text, { ...opts, msgId: t.passive ? poke.msgId : undefined, isWakeup: t.isWakeup });
        }
        return { ok: true, passive: t.passive, isWakeup: t.isWakeup };
      } catch (e) {
        log?.warn?.('回戳一戳时发消息失败:', e.errCode || '', e.message?.slice(0, 160) || '');
      }
    }
    return { ok: false };
  }

  /**
   * 处理「戳一戳」。官方文档没查到单聊/群聊的戳一戳事件与接口，
   * 但网关若推过来（不同版本可能不一样）这里就能接住；
   * 收到的表现是：戳回去（如有接口）+ 说一句话，或者只回一个表情。
   */
  async function handlePoke(poke) {
    if (!poke || pokeCfg.enabled === false) return { skipped: 'poke-off' };
    const scene = poke.scene === 'group' ? 'group' : 'c2c';
    const target = poke.groupId || poke.userId || '';
    if (!target) return { skipped: 'poke-no-target' };
    if (scene === 'group' && modeStore?.isSilent?.()) return { skipped: 'silent' };
    // 他在用这个号自己聊（说了「我上」）：一个字都别发，戳也不回
    if (handoverStore?.isActive?.()) {
      log?.debug?.('接管期间：戳一戳也不理');
      return { skipped: 'handover' };
    }

    const key = `${scene}:${target}`;
    const now = Date.now();
    if (now - (pokeLastAt.get(key) || 0) < Math.max(0, Number(pokeCfg.minIntervalSec) || 0) * 1000) {
      return { skipped: 'poke-cooldown' };
    }
    pokeLastAt.set(key, now);

    const out = { type: poke.type, scene, userId: poke.userId, userName: poke.userName };

    // 1) 戳回去：官方要是没这个接口，这里会返回 unsupported，只留一条 debug，不影响后面说话
    if (pokeCfg.pokeBack !== false) {
      const r = await bot.sendNudge({ scene, userId: poke.userId, groupId: poke.groupId, msgId: poke.msgId }).catch((e) => ({ ok: false, message: e.message }));
      out.pokeBack = !!(r && r.ok);
      if (!out.pokeBack && r?.unsupported && !pokeNotSupported.warned) {
        pokeNotSupported.warned = true;
        log?.info('官方没有「戳一戳」发送接口，戳不回去 —— 改成回一句话（详见 README 第 13 步）');
      }
      // 戳不回去时的近似动作：单聊发一个「正在输入」，看起来最像轻互动（群里不支持）
      if (!out.pokeBack && scene === 'c2c' && pokeCfg.typingFallback !== false && typeof bot.sendTyping === 'function') {
        try {
          await bot.sendTyping(poke.userId, { msgId: poke.msgId, seconds: 5, msgSeq: 1 });
          out.typing = true;
        } catch (e) {
          log?.debug?.('发「正在输入」失败:', e.errCode || '', e.message?.slice(0, 120) || '');
        }
      }
    }

    // 2) 只回一个表情
    if (pokeCfg.replyWithSticker && stickerSvc && stickerList.length && cfg.sticker?.enabled !== false) {
      const pick = stickerList[Math.floor(rng() * stickerList.length)];
      const r = await stickerSvc.send({ scene, groupId: poke.groupId, userId: poke.userId, msgId: poke.msgId }, pick, 1, { passive: !!poke.msgId });
      if (r?.ok) {
        log?.info(`[戳一戳] 回了一个表情「${pick.name}」`);
        return { ...out, sticker: pick.name };
      }
    }

    // 3) 说一句话（默认用模板，省一次模型调用；要让它自己想就把 poke.useModel 打开）
    let text = '';
    if (pokeCfg.useModel) {
      try {
        text = await brain.chat({
          id: scene === 'group' ? `p:${poke.groupId}` : poke.userId,
          name: poke.userName || '',
          userText: '（刚才有人戳了你一下 / 拍了拍你）',
          scene,
        });
      } catch (e) {
        log?.warn?.('戳一戳让模型回话失败:', e.message);
      }
    }
    if (!text) {
      const pool = (pokeCfg.replyTexts || []).filter(Boolean);
      const lines = pool.length ? pool : (scene === 'group' ? POKE_LINES_GROUP : POKE_LINES_C2C);
      text = lines[Math.floor(rng() * lines.length)];
    }
    const sent = await sendToPokeTarget(poke, text);
    log?.info(`[戳一戳] ${scene === 'group' ? '群里' : '私聊'}被动回一句：${text}${sent.ok ? '' : '（没发出去）'}`);
    return { ...out, reply: text, sent };
  }

  /**
   * 潜水模式命令（只有主人说得动）。
   * 返回 null 表示这不是命令，继续正常走。
   * 注意：**小结一律私发**，不往群里贴（群里只回一句「醒了」）。
   */
  /**
   * 日程提醒命令（只认主人私聊）：
   *   「明天早上9点提醒我开会」→ 记下来，回复确认（带编号）
   *   「提醒我 …」但时间没说清 → 让它问一句（不猜）
   *   「我的提醒」/「有哪些提醒」→ 列出来（带编号和倒计时）
   *   「取消提醒」→ 撤掉最近一条
   *   「删除第2条」→ 按编号撤
   *   「删掉开会那个」→ 按关键词撤
   *   「取消全部提醒」→ 清空
   */
  async function handleReminderCommand(msg, text) {
    if (reminderStore.cfg.enabled === false) return null;
    const t = String(text || '').trim();
    const pending = reminderStore.listPending();

    const now = Date.now();
    const BJ = 8 * 3600000;
    const dayKey = (ms) => Math.floor((ms + BJ) / 86400000);       // 北京时间的"第几天"
    const wdOf = (ms) => ((dayKey(ms) + 3) % 7) + 1;               // 1=周一 … 7=周日
    const t0 = dayKey(now);
    // 「第二条」也能认（中文数字）
    const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const toIdx = (s) => {
      if (/^\d+$/.test(s)) return Number(s);
      if (CN[s]) return CN[s];
      if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN[s[1]];
      if (/^[一二三四五六七八九]十$/.test(s)) return CN[s[0]] * 10;
      if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(s)) return CN[s[0]] * 10 + CN[s[2]];
      return NaN;
    };

    // ---- 查看某一条详情：「第2条呢」「第二条是什么」 ----
    let dm = t.match(/^第?\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*条\s*(呢|是什么|详情|内容)?[？?]?$/);
    if (dm) {
      const idx = toIdx(dm[1]);
      const it = pending[idx - 1];
      if (!it) {
        await safeSend(msg, `没有第 ${idx} 条。发「我的日程」看看现在挂着哪些。`, 1);
        return { skipped: 'reminder-detail' };
      }
      await safeSend(msg, `第 ${idx} 条：${it.human}\n· ${it.body}\n· 还有 ${fmtIn(it.at, now)}${it.by ? '' : ''}`, 1);
      return { skipped: 'reminder-detail', id: it.id };
    }

    // ---- 查看日程（各种说法都认） ----
    const bareList = /^(?:今天|今日|明天|明日|后天|本周|这周|这星期|这个星期)?的?(?:我的|我)?(?:提醒|日程|安排)(?:列表|清单|表)?[？?]?$/.test(t)
      || /^(?:我|你)?(?:都)?(?:有)(?:哪些|什么|啥)(?:提醒|日程|安排)[？?]?$/.test(t);
    const askish = /(哪些|什么|啥|列表|清单|查看|看看|多少|几条|全部|所有)/.test(t);
    const listish = bareList || (askish && /日程|提醒|安排/.test(t)
      && !/(设|定|加|记一下|记下|建|清空|撤销|取消|删)/.test(t));
    if (listish) {
      let scope = 'all';
      let title = '你记着的事';
      if (/今天|今日/.test(t)) { scope = 'today'; title = '今天的事'; }
      else if (/明天|明日/.test(t)) { scope = 'tomorrow'; title = '明天的事'; }
      else if (/后天/.test(t)) { scope = 'day2'; title = '后天的事'; }
      else if (/本周|这周|这星期|这个星期/.test(t)) { scope = 'week'; title = '这周的事'; }

      const filtered = pending.filter((it) => {
        const d = dayKey(it.at) - t0;
        if (scope === 'today') return d === 0;
        if (scope === 'tomorrow') return d === 1;
        if (scope === 'day2') return d === 2;
        if (scope === 'week') return d >= 0 && d <= Math.max(0, 7 - wdOf(now));
        return true;
      });

      if (!filtered.length) {
        const tail = pending.length ? `\n（你总共还有 ${pending.length} 条，发「我的日程」看全部）` : '';
        await safeSend(msg, `${title}：没有。${tail}`, 1);
        return { skipped: 'reminder-list' };
      }

      // 按 今天 / 明天 / 本周 / 以后 分组，编号沿用全体顺序（删的时候按这个号）
      const groups = new Map([['今天', []], ['明天', []], ['本周', []], ['以后', []]]);
      const idxOf = new Map(pending.map((it, i) => [it.id, i + 1]));
      for (const it of filtered) {
        const d = dayKey(it.at) - t0;
        const until = Math.max(0, 7 - wdOf(now));
        const g = d === 0 ? '今天' : d === 1 ? '明天' : (d > 1 && d <= until) ? '本周' : '以后';
        groups.get(g).push(it);
      }
      const out = [`${title}（${filtered.length} 件）：`];
      for (const [g, items] of groups) {
        if (!items.length) continue;
        out.push('', `【${g}】`);
        for (const it of items) out.push(`${idxOf.get(it.id)}. ${it.human.replace(/^(\d+月\d+日)\s*周(.)\s*/, '$1 周$2 ')} · ${it.body}｜${fmtIn(it.at, now)}`);
      }
      out.push('', '删一条：「删掉第2条」或「取消开会那个」');
      await safeSend(msg, out.join('\n'), 1);
      return { skipped: 'reminder-list', count: filtered.length };
    }

    // ---- 按编号删（「删掉第2条」「取消第一条日程」都认） ----
    let m = t.match(/^(?:取消|删除|删掉|去掉|撤销)\s*第?\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*条?\s*(?:的)?\s*(?:提醒|日程|安排)?[？?]?$/);
    if (m) {
      const i = toIdx(m[1]);
      const removed = reminderStore.cancelByIndex(i);
      await safeSend(msg, removed
        ? `删了第 ${i} 条：${removed.human} · ${removed.body}`
        : `没有第 ${i} 条提醒。说「我的日程」看看现在挂着哪些。`, 1);
      return { skipped: 'reminder-cancel', removed: removed ? removed.id : null };
    }

    // ---- 清空 ----
    if (/^(?:取消|删除|删掉|清空)(?:全部|所有|所有提醒|全部提醒)?(?:的)?(?:提醒|日程)$/.test(t) &&
        /全部|所有|清空/.test(t)) {
      const cleared = reminderStore.cancelAll();
      await safeSend(msg, cleared.length
        ? `清空了 ${cleared.length} 条提醒。`
        : '现在本来就没有挂着的提醒。', 1);
      return { skipped: 'reminder-cancel-all', removed: cleared.length };
    }

    // ---- 撤掉最近一条 ----
    if (/^(取消提醒|取消日程|不用提醒了|别提醒了|不要提醒了)$/.test(t)) {
      const removed = reminderStore.cancelLast();
      await safeSend(msg, removed
        ? `取消了：${removed.human} · ${removed.body}`
        : '现在没有等你确认的提醒。', 1);
      return { skipped: 'reminder-cancel', removed: removed ? removed.id : null };
    }

    // ---- 按关键词删：「删掉开会那个」「取消明天那个」 ----
    m = t.match(/^(?:取消|删除|删掉|去掉|撤销)(?:那个)?(.+?)(?:那个|这条|那条)?(?:提醒|日程)?$/);
    if (m && m[1] && m[1].length <= 20) {
      const removed = reminderStore.cancelByKeyword(m[1]);
      if (removed) {
        await safeSend(msg, `删了：${removed.human} · ${removed.body}`, 1);
        return { skipped: 'reminder-cancel', removed: removed.id };
      }
    }

    // ---- 新增 ----
    const parsed = parseReminder(t, Date.now());
    if (!parsed) {
      // 明确在要求提醒、但时间没认出来 → 只追问，不瞎猜（也不乱记）
      if (isReminderRequest(t) || /提醒我/.test(t)) {
        await safeSend(msg, '几点提醒你？说「明天9点」「30分钟后」这种我就能记。', 1);
        return { skipped: 'reminder-ask' };
      }
      // 说的是日程但没听懂 → 给个菜单，别让模型瞎编（她以前会现编"记着的就一句话"）
      if (/日程|安排/.test(t) && t.length <= 24) {
        await safeSend(msg, '日程我是这样用的：\n· 记：明天9点提醒我开会\n· 看：我的日程 / 今天的日程 / 明天的日程\n· 删：删掉第2条 / 取消开会那个\n· 清：清空全部日程', 1);
        return { skipped: 'reminder-menu' };
      }
      return null;
    }

    const r = reminderStore.add({ at: parsed.at, body: parsed.body, human: parsed.human, by: msg.userId });
    if (!r.ok) {
      await safeSend(msg, '提醒排太多了，先说「我的提醒」看看，删掉几条再加。', 1);
      return { skipped: 'reminder-full' };
    }
    log?.info?.(`日程提醒：已记录 #${r.item.id} ${parsed.human} · ${parsed.body}`);
    const rel = fmtIn(parsed.at, Date.now());
    await safeSend(msg, `记住了（第 ${reminderStore.listPending().findIndex((x) => x.id === r.item.id) + 1} 条）：${parsed.human} 提醒你「${parsed.body}」，还有 ${rel}。`, 1);
    return { skipped: 'reminder-set', reminder: r.item };
  }

  async function handleModeCommand(msg, text, { isGroup }) {
    if (!modeStore || !modeStore.settings || modeStore.settings.enabled === false) return null;
    const cmd = modeStore.match(text);
    if (!cmd) return null;
    const who = msg.userName || msg.userId || '';

    if (cmd === 'silent') {
      if (modeStore.isSilent()) {
        await safeSend(msg, '已经在潜水了。', 1);
        return { command: 'silent', already: true };
      }
      modeStore.set(true, { by: who });
      await safeSend(msg, isGroup
        ? '行，我潜水了。群里我一个字都不发，但会听着，回头私聊给你讲。'
        : '行，我潜水了。群里我一个字都不发，但会听着，回头给你讲。', 1);
      return { command: 'silent' };
    }

    if (cmd === 'wake') {
      if (!modeStore.isSilent()) {
        await safeSend(msg, '我没在潜水啊。', 1);
        return { command: 'wake', already: true };
      }
      const snap = modeStore.snapshot();
      modeStore.set(false, { by: who });
      const sum = modeStore.settings.summarize !== false && modeStore.settings.summarizeOnWake !== false
        ? await buildSilentSummary({ since: snap.since })
        : '';
      if (!isGroup) {
        await safeSend(msg, '醒了。', 1);
        if (sum) await safeSend(msg, sum, 2);
        return { command: 'wake', privateSummary: false };
      }
      // 群里说的「浮上来」：群里只回一句，小结私聊发
      await safeSend(msg, '醒了。', 1);
      if (!sum) return { command: 'wake', privateSummary: true, summarySent: false };
      const ok = await sendPrivateToOwner(sum, { seq: 1 });
      if (!ok) {
        await safeSend(msg, '小结我私聊发你，但没发出去（个人主体的主动消息常被平台拦）。你在私聊里说一句「潜水总结」，我就发给你。', 2);
      }
      return { command: 'wake', privateSummary: true, summarySent: ok };
    }

    if (cmd === 'summary') {
      if (modeStore.settings.summarize === false) {
        await safeSend(msg, '不总结了（你让我别再花时间总结群消息）。想知道群里的事直接问我。', 1);
        return { command: 'summary', disabled: true };
      }
      const snap = modeStore.snapshot();
      const sum = await buildSilentSummary({
        since: modeStore.isSilent() ? snap.since : Date.now() - (modeStore.settings.summaryHours ?? 8) * 3600000,
      }) || '最近群里没聊什么正事。';
      if (!isGroup) {
        await safeSend(msg, sum, 1);
        return { command: 'summary', privateSummary: false };
      }
      const ok = await sendPrivateToOwner(sum, { seq: 1 });
      await safeSend(msg, ok ? '私聊发你了。' : '想私发给你，但消息被平台拦了。你在私聊里说一句「潜水总结」我就发。', 1);
      return { command: 'summary', privateSummary: true, summarySent: ok };
    }
    return null;
  }

  /**
   * 「群名叫 XXX」这类命令：把群名记下来，以后小结和你问起来都用真名字。
   * 只有主人说得动。返回 null 表示不是这类命令。
   */
  async function handleGroupNameCommand(msg, text, { isGroup }) {
    if (!groupNames || !groupNames.settings || groupNames.settings.enabled === false) return null;
    const labelOf = (gid) => groupLog?.labelOf?.(gid) || '';
    const resolveLabel = (label) => (groupLog?.findGroup ? groupLog.findGroup(label) : '');    const hit = groupNames.learn({
      text,
      groupId: isGroup ? msg.groupId : '',
      isGroup,
      labelOf: isGroup ? labelOf : null,
      resolveLabel,
    });
    if (!hit) return null;
    if (hit.missing) {
      await safeSend(msg, `我现在还不认识「${hit.label}」这个群（它得先在群里说过话我才知道是谁）。`, 1);
      return { command: 'group-name', missing: true };
    }
    await safeSend(msg, `记下了：${hit.label || '这个群'}叫「${hit.name}」。`, 1);
    return { command: 'group-name', ...hit };
  }

  /**
   * 决定这条回复要用几条消息发出去：
   *   节奏开着（且是私聊）-> 按句子拆成 1–3 条短的
   *   否则（或拆完超过被动回复上限）-> 按长度分段
   */
  function planBubbles(reply, msg) {
    const limit = PASSIVE_LIMIT[msg.scene] ?? 4;
    const useRhythm = rhythm.enabled && msg.scene === 'c2c' && !rhythm.disabled;
    if (!useRhythm) return splitReply(reply, cfg.qq.maxReplyChars);

    const raw = splitBubbles(reply, {
      maxCharsPerBubble: rhythm.maxCharsPerBubble,
      maxBubbles: rhythm.maxBubbles,
    });
    const out = [];
    for (const b of raw) for (const piece of splitReply(b, cfg.qq.maxReplyChars)) out.push(piece);
    // 拆得太碎就退回普通分段，省得一条回复把被动额度刷干
    if (out.length > limit) return splitReply(reply, cfg.qq.maxReplyChars);
    return out;
  }

  async function safeSend(...args) {
    try { return await send(...args); }
    catch (e) {
      // 40054005 = 同一个 msg_id + msg_seq 已经发过（重复投递/重连补发），当成功处理，避免再发一遍
      if (e.errCode === 40054005) { log?.debug?.('消息已发过，跳过重复发送'); return { deduped: true }; }
      log?.error('发送失败:', e.errCode || '', e.message);
      if (e.errCode === 40034100) log?.warn('主动消息被限流（40034100），回复可能没送达');
      if (e.errCode === 40034128) log?.warn('被动回复超过时限/次数（40034128）');
      if (e.errCode === 40054010) log?.warn('群消息里不允许发 URL（40054010）');
      if (e.errCode === 1100101) log?.warn('内容安全拦截（1100101），这句没发出去');
      if (e.errCode === 40054004) log?.warn('对方和机器人没有好友关系（40054004），先在 QQ 里把机器人加上');
      return null;
    }
  }

  /**
   * 被动回复失败（比如模型太慢，超过 5 分钟窗口）时，自动降级成主动消息重试一次。
   * 40054005 = msg_id+msg_seq 重复，说明其实已经发出去了，视为成功。
   */
  async function sendWithFallback(msg, content, seq, passive) {
    const r = await safeSend(msg, content, seq, { passive });
    if (r) return { ok: true, passive, content };
    if (!passive) return { ok: false, passive, content };
    log?.info('被动回复失败，改发主动消息重试');
    const r2 = await safeSend(msg, content, seq, { passive: false });
    return { ok: !!r2, passive: false, content };
  }

  async function handle(msg) {
    const isGroup = msg.scene === 'group';

    // 单聊：qq.allowFrom 只管私聊；群聊另用 qq.allowGroups
    if (!isGroup && cfg.qq.allowFrom.length && !cfg.qq.allowFrom.includes(msg.userId)) {
      log?.warn('不在白名单，已忽略:', msg.userId, '（如需放行，加进 config.json 的 qq.allowFrom）');
      return { skipped: 'not-allowed' };
    }
    if (isGroup) {
      if (!groupAllowed(msg)) {
        log?.info('这个群不在 allowGroups 里，已忽略:', msg.groupId);
        return { skipped: 'group-not-allowed' };
      }
      if (!cfg.qq.replyInGroup) return { skipped: 'group-off' };
    }

    const rawText = String(msg.content || '').trim();
    // 转发的聊天记录：正文藏在 msg_elements 里（qq.js 已经抽出来了），别当成「没有文字」丢掉
    const forwardText = String(msg.forwardText || '').trim();
    const isForward = !!(msg.forwarded || forwardText);
    let text = rawText === forwardText ? (forwardText ? '（转发了一份聊天记录）' : '') : rawText;
    // 先认人：是不是他本人（你）在说话
    // 记一下这个群有没有推「没 @ 我」的消息（决定要不要提醒群主去开全量）
    if (isGroup && groupScope) groupScope.note(msg);

    const ownerHit = ownerStore ? ownerStore.match(msg) : { owner: false, reason: null };
    const fromOwner = ownerHit.owner;
    if (fromOwner && (ownerHit.reason === 'name' || ownerHit.reason === 'alias') && ownerStore) ownerStore.learn(msg);
    // 别人带脏字冲它来？先认出来（主人在群里没被叫名字就不接，见下面 owner-not-called）
    const hostileHit = detectHostile({
      text,
      isGroup,
      mentioned: msg.mentioned === true,
      botNames: cfg.qq.botNames || [],
      fromOwner,
    });
    const hostileNow = hostileHit.hostile && cfg.qq.hostile?.enabled !== false;
    if (hostileHit.words.length) {
      log?.debug?.(
        `脏字检测：${hostileHit.words.join('/')} · 目标=${hostileNow ? hostileHit.reason : 'not-targeted'}`
      );
    }
    // 你本人在群里说话：默认不接，等你明确叫它（@ 它 / 句子里带「水鸡」）它才反应
    const ownerAlways = fromOwner && (!isGroup || ownerStore?.settings?.alwaysReply === true);
    const mentioned = ownerAlways ? true : (isGroup ? msg.mentioned !== false : true);

    // 群里的每条消息都记进上下文（包括不回的），判断氛围要靠这个
    // （定时扫「冷场问题」时会用问题的原文再走一遍 handle，那种情况不用重复记）
    if (isGroup && !msg.__answerNow) rememberLine(msg.groupId, msg.userName, text || '(非文本消息)');
    // 另外单独记一份群聊日志：私聊里问「群里聊啥了」要靠它
    if (isGroup && groupLog && !msg.__answerNow) groupLog.record({ groupId: msg.groupId, who: msg.userName, text });

    // 群里问题的跟踪：判断「很多人回过了还没答到点上」或者「一直没人回」
    let answerTarget = null;
    if (isGroup) {
      const st = gstate(msg.groupId);
      const fromBot = (msg.userName || '') === BOT_NAME || msg.raw?.author?.bot === true;
      const isQuestion = looksLikeQuestion(text) && String(text).length >= (groupAnswer.minChars ?? 6);
      // 有人接着说话：算对上一个问题的一次「回复」
      if (st.pending && !st.pending.answeredAt && !fromBot && msg.userId !== st.pending.byId) {
        st.pending.replies += 1;
      }
      // 新的问题：覆盖掉旧的（但旧问题还在「解决中」就别被别人的追问挤掉，10 分钟后才换）
      const stalePending = !st.pending || st.pending.answeredAt || Date.now() - st.pending.at > 10 * 60 * 1000;
      if (!fromBot && isQuestion && stalePending) {
        st.pending = {
          text: String(text).slice(0, 200),
          by: msg.userName || '有人',
          byId: msg.userId,
          msgId: msg.msgId,
          at: Date.now(),
          replies: 0,
          answeredAt: 0,
        };
      }
      const p = st.pending;
      const forceAnswer = msg.__answerNow === true;
      // 刚问出来的问题这一轮先不答（还没「没人理」的时间），要么等别人回、要么等定时扫
      const justAsked = !forceAnswer && isQuestion && p && p.msgId === msg.msgId;
      if (!justAsked && p && !p.answeredAt && groupAnswer.enabled !== false && (forceAnswer || (!mentioned && !hostileNow))) {
        const ageMs = Date.now() - p.at;
        const hot = p.replies >= (groupAnswer.hotReplies ?? 3);
        const cold = ageMs >= (groupAnswer.coldSeconds ?? 180) * 1000;
        if (hot || cold) {
          const why = answerBudget(st);
          // 这个问题是在问别人（@ 了不是它的名字）→ 别抢答，免得「找错人」
          if (!why && asksSomeoneElse(p.text, cfg.qq.botNames || [])) {
            p.answeredAt = Date.now();
            log?.info(`[群里] 这个问题是问别人的，不接：${p.text.slice(0, 30)}`);
          } else if (why) {
            log?.info(`[群里] 有个问题想答，先不答（${why}）：${p.text.slice(0, 30)}`);
          } else {
            answerTarget = p;
            log?.info(
              `[群里] 主动答问题（${hot ? `已有 ${p.replies} 人回过` : `冷了 ${Math.round(ageMs / 1000)}s`}）` +
              `← ${p.by}：${p.text.slice(0, 40)}`
            );
          }
        }
      }
    }

    // 主人的潜水命令：「潜水」闭嘴、「浮上来」恢复、「潜水总结」要小结（别人说不管用）
    if (fromOwner) {
      const done = await handleModeCommand(msg, text, { isGroup });
      if (done) return done;
      // 「群名叫 XXX」：把群名记下来（只有主人说得动）
      const named = await handleGroupNameCommand(msg, text, { isGroup });
      if (named) return named;
    }
    // 日程提醒：只给主人用，只在私聊里认（群里说要提醒 = 闲聊，不抢）
    if (reminderStore && fromOwner && !isGroup) {
      const done = await handleReminderCommand(msg, text);
      if (done) return done;
    }

    // 手动接管：「我上」→ 它闭嘴（消息照记不回复），「你上」→ 它回来。只有主人说得动。
    if (handoverStore) {
      const hcmd = matchHandoverCommand(text, handoverStore.settings);
      if (hcmd && fromOwner) {
        const takeOver = hcmd === 'takeover';
        handoverStore.set(takeOver, { by: msg.userName || msg.userId });
        await safeSend(msg, takeOver ? handoverStore.settings.takeOverReply : handoverStore.settings.releaseReply, 1);
        return { skipped: 'handover-cmd', command: hcmd, handover: hcmd };
      }
      if (handoverStore.isActive()) {
        // 你亲自聊的这段时间：只把消息记进记忆，一个字都不发，回来后它才知道中间说了什么
        const memId = isGroup ? `g:${msg.groupId}` : msg.userId;
        try {
          memoryStore?.addTurn(memId, 'user', isGroup ? `${msg.userName || '有人'}：${text}` : text);
        } catch {}
        log?.debug?.('接管期间：只记录不回复');
        return { skipped: 'handover' };
      }
    }

    // 潜水期间：群里一个字都不发（消息照记，不接话、不贴表情、@ 也不理）
    if (isGroup && modeStore?.isSilent()) {
      log?.debug?.('潜水模式：这条只记录不回复');
      return { skipped: 'silent' };
    }

    // 你在群里说话但没叫它（没 @ 你、句子里也没「水鸡」）→ 不接，免得句句都回
    if (isGroup && fromOwner && !mentioned && !hostileNow && !answerTarget) {
      log?.debug?.('主人没叫它，这条不接:', text.slice(0, 20));
      return { skipped: 'owner-not-called' };
    }

    // 「有人找你」第 1 类：别人明确在找主人（不是主人自己在说话）
    // 这种情况不硬编，先照常回一句，同时悄悄私信主人「有人找你，去上号」。
    let notifyFindHit = false;
    if (!fromOwner && notifySvc) {
      const ownerFindHit = looksForOwner(text);
      if (ownerFindHit) {
        log?.info?.(`[有人找] ${msg.userName || msg.userId} 在找主人：${text.slice(0, 30)}`);
        // 记下来：之后模型如果又答非所问 / 说不知道，也走同一个窗口的提醒（被冷却挡掉，不会刷屏）
        notifyFindHit = true;
        await notifySvc
          .maybe({
            kind: 'find',
            reason: `${msg.userName || msg.userId}：${text.slice(0, 40)}`,
            msg,
            window: isGroup ? `g:${msg.groupId}` : msg.userId,
            who: msg.userId,
          })
          .catch(() => {});
      }
    }

    // 别人发的图：不管后面聊不聊，先存进表情库（这就是「学别人用过的表情包」）
    let learnedNames = [];
    if (learner && msg.attachments?.length) {
      try {
        const r = await learner.learnFromMessage(msg, {
          text,
          source: isGroup ? `群 ${msg.groupId}` : msg.userId,
        });
        learnedNames = r.names || [];
      } catch (e) {
        log?.warn?.('学表情失败:', e.message);
      }
    }

    // 群里「嗯」「哈哈」这种：不调模型直接跳过，反应快、也省钱（挨骂时例外，得回嘴）
    if (isGroup && !mentioned && !hostileNow && !answerTarget && isTrivialChatter(text)) {
      log?.debug?.('群里这条没啥信息量，不接:', text.slice(0, 20));
      return { skipped: 'group-trivial', learned: learnedNames };
    }

    if (!text) {
      // 只有图、没有文字：如果它本来就该回（私聊 / 群里被叫到 / 挨骂），那就看图说话
      const visionOn = visionSvc && cfg.qq.vision?.enabled !== false;
      const willAnswer = !isGroup || mentioned || hostileNow;
      if (msg.attachments?.length && visionOn && willAnswer) {
        log?.info('收到只带图片的消息，试着看图');
        // 往下走，让 brain 带着图回答（给一段占位文字，模型才不会以为这条是空的）
        text = '（他发了张图，没打字）';
      } else {
        if (msg.attachments?.length) {
          const kinds = [...new Set(msg.attachments.map((a) => a.content_type))].join(',');
          log?.info('收到非文字消息:', kinds, learnedNames.length ? `（学会了 ${learnedNames.join('、')}）` : '');
          // 群里没 @ 就不吭声，免得刷屏
          if (mentioned) {
            const line = learnedNames.length
              ? LEARN_ACK_LINES[Math.floor(rng() * LEARN_ACK_LINES.length)]
              : '图片/语音/文件我这边看不了内容，你打字说吧～';
            await safeSend(msg, line, 1);
          }
        }
        return { skipped: 'empty', learned: learnedNames };
      }
    }

    // 群聊里没 @ 我的消息：先判断要不要自己接一句
    let allowPass = false;
    if (isGroup && !mentioned && !answerTarget) {
      // 挨骂不排队：不吃冷却、不受每小时上限管，直接回嘴
      const hostileBypass = hostileNow && cfg.qq.hostile?.bypassCooldown !== false;
      if (hostileBypass) {
        log?.info(`[群里] 有人骂它（${hostileHit.words.join('/')}），不排队直接回：${text.slice(0, 40)}`);
      } else {
        // 排队太久才轮到的消息：话题早过去了，这时候回就是"插一句跟对话无关的话"
        const staleMs = Number(groupAuto.staleSkipMs) || 0;
        const age = Number(msg.timestamp) ? Date.now() - Number(msg.timestamp) : 0;
        if (staleMs > 0 && age > staleMs) {
          log?.info(`[群里] 这条排了 ${Math.round(age / 1000)}s 才轮到，不回了：${text.slice(0, 30)}`);
          return { skipped: 'group-stale' };
        }
        if (!groupAuto.enabled) return { skipped: 'group-auto-off' };

        const budgetReason = groupBudget(msg.groupId);
        if (budgetReason) {
          const h = groupHeat(gstate(msg.groupId));
          const win = groupAuto.hotWindowSec ?? 60;
          log?.info(
            `[群里] 这次先不插话（${budgetReason}）· 近 ${win}s 有 ${h.people} 人说了 ${h.messages} 句`,
          );
          return { skipped: budgetReason };
        }

        // 没人 @ 她的时候分两层：群里有人正在聊就别硬插，真冷场了才补一句
        const timing = passiveTiming(msg.groupId);
        if (!timing.ok) {
          log?.info(
            `[群里] 人家正聊着，先不插（${timing.silent}s 前还有人说话 · 近 60s ${timing.people} 人 ${timing.messages} 句）：${text.slice(0, 30)}`,
          );
          return { skipped: timing.reason };
        }

        const policy = joinPolicy(msg, text);
        if (!policy) return { skipped: 'group-not-joining' };
        allowPass = policy.allowPass;
        log?.info(`[群里] 准备接话（${groupAuto.mode}）← ${msg.userName || msg.userId}：${text.slice(0, 40)}`);
      }
    }

    // 轻量指令（群里只在自己被 @ 时才理）
    if (mentioned && /^\/?(ping|在吗)$/i.test(text)) {
      await safeSend(msg, '在。', 1);
      return { skipped: 'command' };
    }

    // 记忆键：单聊按人，群聊按群（一个群一份连续对话）
    const memId = isGroup ? `g:${msg.groupId}` : msg.userId;
    // 主动答题时，喂给模型的是「那个问题」本身，而不是此刻插进来的闲聊
    let userText;
    if (isGroup && answerTarget) {
      const recent = gstate(msg.groupId).lines.slice(-4).join('\n');
      userText = `${answerTarget.by || '有人'}：${answerTarget.text}` +
        `\n（这个问题后面已经有 ${answerTarget.replies} 条零碎回复，没解决）` +
        `\n群里最近这几句：\n${recent}`;
    } else {
      userText = isGroup ? `${msg.userName || '有人'}：${text}` : text;
    }
    // 转发的聊天记录太长，塞不进历史（会被截到 240 字），单独走 forwardText 通道
    const forwardForBrain = isForward ? forwardText : '';
    const groupContext = isGroup
      ? gstate(msg.groupId).lines.slice(-groupAuto.contextSize - 1, -1)
        .map((l) => (l.length > 80 ? l.slice(0, 80) + '…' : l))
        .join('\n')
      : '';

    // 可选：「正在输入」提示（单聊专属，会占一次被动回复额度）
    if (cfg.qq.typing && msg.scene === 'c2c') {
      try { bot.sendTyping(msg.userId, { msgId: msg.msgId, msgSeq: 1, seconds: 15 }).catch(() => {}); } catch {}
    }

    // 私聊：如果有群还没开「接收全部群消息」，顺口提醒主人（只提醒一次，24 小时内不重复）
    let scopeHints = [];
    let scopeHintIds = [];
    if (!isGroup && groupScope) {
      const labelOf = (id) => groupDisplayName(id);
      const hs = groupScope.hints(labelOf);
      scopeHintIds = hs.map((h) => h.groupId);
      scopeHints = hs.map((h) => h.text);
    }

    const t0 = Date.now();

    // 看图：把这条消息里的图下载下来给模型（私聊都看；群里只有被叫到才看）
    let images = [];
    if (visionSvc && Array.isArray(msg.images) && msg.images.length) {
      try {
        const vr = await visionSvc.load(msg.images, { isGroup, mentioned });
        images = vr.items || [];
        if (vr.skipped) log?.debug?.('这张图没看:', vr.skipped);
        else if (images.length) log?.info(`看图：${images.length} 张（${Math.round((images[0].bytes || 0) / 1024)}KB 起）`);
      } catch (e) {
        log?.warn?.('看图失败:', e.message);
      }
    }

    // 联网搜索：这句话看着像需要新鲜信息才搜（不然白花钱）
    let searchContext = '';
    let searchQuery = '';
    if (searchSvc && text) {
      const plan = searchSvc.planSearch(text, { isGroup, mentioned });
      if (plan.need && plan.query) {
        try {
          const r = await searchSvc.search(plan.query, { userKey: isGroup ? `g:${msg.groupId}` : msg.userId });
          if (r.ok && r.results?.length) {
            searchQuery = plan.query;
            searchContext = searchSvc.buildContext(r.results, { query: plan.query });
            log?.info(`联网查了「${plan.query}」（${plan.reason}）：${r.results.length} 条${r.cached ? '·缓存' : ''}`);
          } else {
            log?.info(`想查「${plan.query}」但没搜到（${r.reason || r.error || 'empty'}）`);
          }
        } catch (e) {
          log?.warn?.('联网搜索出错:', e.message);
        }
      } else if (plan.need === false && plan.reason !== 'off') {
        log?.debug?.('这句不用联网:', plan.reason);
      }
    }

    let reply;
    try {
      reply = await brain.chat({
        id: memId,
        name: isGroup ? null : msg.userName,
        userText,
        scene: msg.scene,
        groupContext,
        allowPass,
        stickerNudge: repliesSinceSticker >= 3,
        fromOwner,
        forwardText: forwardForBrain,
        speaker: isGroup ? msg.userName || '' : '',
        scopeHints,
        hostile: hostileNow ? hostileHit.words : [],
        images,
        searchContext,
        groupProfile: isGroup ? (cfg.qq?.groupProfiles?.[msg.groupId] || cfg.qq?.groupProfiles?.[String(msg.groupId)] || '') : '',
        answerNote: answerTarget
          ? {
            text: answerTarget.text,
            by: answerTarget.by,
            replies: answerTarget.replies,
            ageSec: Math.round((Date.now() - answerTarget.at) / 1000),
          }
          : null,
      });
    } catch (e) {
      log?.error('模型调用失败:', e.message);
      // 群里挂了就不吭声，只有私聊才提示
      if (!isGroup) await safeSend(msg, '我这边卡了一下（模型没响应），你等下再发一遍？', 1);
      return { error: e.message };
    }
    if (scopeHintIds.length && groupScope) groupScope.markHinted(scopeHintIds);

    // 「有人找你」第 2 类：她不吭声了（PASS）。
    // 群里 PASS 多半是「不想接话」，正常；但私聊里 PASS 就是「接不住」，
    // 该让主人来。所以私聊 PASS 时悄悄给主人发一条。
    if (!fromOwner && notifySvc && !isGroup && !String(reply || '').trim()) {      notifySvc
        .maybe({
          kind: 'stuck',
          reason: `${msg.userName || msg.userId} 说「${text.slice(0, 30)}」，她没接上`,
          msg,
          window: msg.userId,
          who: msg.userId,
        })
        .catch(() => {});
    }

    // 模型判断这条不值得插话（只回了 PASS）
    if (!String(reply || '').trim()) {
      // 群里不想接话时，先试试真·贴表情（在对方那条消息下面点一个），
      // 贴不成再退回发一张小表情图。
      if (isGroup) {
        const liked = await tryEmojiLike(msg, emojiLiker ? emojiLiker.toneOf(text) : 'neutral', { probability: 1 });
        if (liked) {
          log?.info(`[群里] 这条不接话，贴了个表情「${liked.name}」：${text.slice(0, 40)}`);
          return { skipped: 'group-pass', emojiLike: liked.name };
        }
        const why = reactBudget(msg);
        if (!why) {
          const pick = stickerList[Math.floor(rng() * stickerList.length)];
          gstate(msg.groupId).lastReactAt = Date.now();
          const r = await stickerSvc.send(msg, pick, 1, { passive: true });
          if (r?.ok) {
            log?.info(`[群里] 这条不接话，贴了个表情「${pick.name}」：${text.slice(0, 40)}`);
            return { skipped: 'group-pass', reacted: pick.name };
          }
          log?.debug?.('贴表情没发出去:', r?.reason || '', r?.errCode || '');
        }
        log?.info(`[群里] 这条想了想还是不接了：${text.slice(0, 40)}（不贴表情：${why}）`);
        return { skipped: 'group-pass' };
      }
      return { skipped: 'group-pass' };
    }

    // 表情包：模型可能把 [[表情:名字]] 写在最后一行，这里抽出来单独发
    // （模型偶尔不按套路返回对象，这里兜一层，别把 "[object Object]" 发到群里）
    let replyText = reply && typeof reply === 'object'
      ? String(reply.text || reply.reply || reply.content || '')
      : String(reply ?? '');
    replyText = normalizeReply(replyText);
  // 他平时一行一句、末尾不带标点。这个行为由 qq.naturalLines 控制（默认关，config.json 里打开）
  if (cfg.qq?.naturalLines === true) replyText = breakNatural(replyText, 15);
    let sticker = null;
    if (stickerSvc && cfg.sticker?.enabled !== false) {
      const ex = extractSticker(replyText, stickerList);
      replyText = ex.text;
      if (ex.requested) {
        if (!ex.sticker) log?.debug?.('模型想用的表情不在目录里，忽略:', ex.requested);
        else if (!stickerSvc.canSend(stickerSvc.sessionKey(msg))) {
          log?.debug?.('表情还在冷却，这条不发表情');
        } else sticker = ex.sticker;
      }
      // 只剩一个不认识的表情标记、没有文字 -> 还是把原始内容发出去，别闷着
      if (!replyText && !sticker) replyText = String(reply).trim();
    }

    const latencyMs = Date.now() - t0;
    // 主动答题时说过的话别再说一遍（用户反馈：群聊主动开口会出现「莫名其妙重复」）
    // 只对「主动答题」这一路生效：正常接话时同样的话再说一次是合理的
    if (isGroup && replyText && answerTarget) {
      const stx = gstate(msg.groupId);
      const win = (groupTopic.dupWindowMinutes ?? 40) * 60000;
      const dup = (stx.botLines || []).some((l) => Date.now() - l.at < win && simText(l.text, replyText) > 0.72);
      if (dup) {
        if (answerTarget) answerTarget.answeredAt = Date.now();
        log?.info(`[群里] 这句刚说过，不重复：${replyText.slice(0, 20)}`);
        return { skipped: 'dup-reply' };
      }
    }
    const chunks = replyText ? planBubbles(replyText, msg) : [];
    // 主动答题：默认直接在提问那条消息下回答（不 @，见 atPrefixFor 的注释）
    if (answerTarget) {
      const prefix = atPrefixFor(answerTarget);
      if (prefix) {
        if (chunks.length) chunks[0] = prefix + chunks[0];
        else chunks.push(prefix.trim());
      }
      answerTarget.answeredAt = Date.now();
      const st = gstate(msg.groupId);
      st.answerStamps = [...(st.answerStamps || []), Date.now()];
      log?.info(
        `[群里] 主动应答（${prefix ? '@ ' + answerTarget.by : '不 @ ' + answerTarget.by}）：${replyText.slice(0, 40)}`
      );
    }
    // 主动答题时，回复挂在「提问的那条消息」上（被动回复，5 分钟内有效）
    const outMsg = answerTarget && answerTarget.msgId ? { ...msg, msgId: answerTarget.msgId } : msg;
    const limit = PASSIVE_LIMIT[msg.scene] ?? 4;
    // 表情要额外占一条被动回复额度，额度不够就这轮不发
    if (sticker && chunks.length + 1 > limit) {
      log?.debug?.('被动回复额度不够，这条不发表情');
      sticker = null;
    }
    const paced = rhythm.enabled && msg.scene === 'c2c';

    if (isGroup) {
      rememberLine(msg.groupId, BOT_NAME, replyText + (sticker ? '（表情）' : ''));
      markSpoke(msg.groupId);
      if (groupLog && replyText) groupLog.record({ groupId: msg.groupId, who: '我', text: replyText });
      // 记下自己说过什么，用来挡重复
      if (replyText) {
        const stx = gstate(msg.groupId);
        stx.botLines = [...(stx.botLines || []), { text: replyText, at: Date.now() }].slice(-20);
      }
    }

    log?.info(
      `回复耗时 ${(latencyMs / 1000).toFixed(1)}s，长度 ${replyText.length}，` +
      `分 ${chunks.length} 段${paced ? '（真人节奏）' : ''}${sticker ? ` + 表情「${sticker.name}」` : ''}`
    );
    // 留一份「她到底说了什么」的存底，方便事后回查幻觉（只保留最近 500 条）
    try {
      const dir = cfg.paths?.data || path.join(__dirname, '..', 'data');
      const file = path.join(dir, 'replies.log');
      const line = JSON.stringify({
        at: new Date().toISOString(),
        scene: msg.scene,
        name: msg.userName || msg.name || '',
        in: String(msg.content || '').slice(0, 300),
        out: String(replyText || '').slice(0, 500),
      }) + '\n';
      fs.appendFileSync(file, line);
      const buf = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (buf.length > 500) fs.writeFileSync(file, buf.slice(-500).join('\n') + '\n');
    } catch { /* 写不了就算了，不影响回复 */ }
    // 记一句「我刚说的」，给自我反思当素材
    try { brain.noteSelfLine?.(replyText); } catch { /* 忽略 */ }

    const delays = paced ? bubbleDelays(chunks, rhythm, rng) : chunks.map(() => 0);
    const sent = [];
    for (let i = 0; i < chunks.length; i++) {
      const wait = paced ? delays[i] : (i > 0 ? 350 : 0);
      if (wait > 0) await sleepFn(wait);
      const r = await sendWithFallback(outMsg, chunks[i], i + 1, i < limit);
      sent.push(r);
    }

    // 表情跟在最后一条后面，稍微停一下，像人翻表情包的时间
    let stickerSent = null;
    if (sticker) {
      const wait = paced ? 300 + Math.floor(rng() * 700) : (chunks.length ? 400 : 0);
      if (wait > 0) await sleepFn(wait);
      const seq = chunks.length + 1;
      stickerSent = await stickerSvc.send(outMsg, sticker, seq, { passive: seq <= limit });
    }

    // 顺手给这条消息贴个表情（真人常干这事）：概率 + 冷却控制，不打扰
    const emojiLiked = replyText
      ? await tryEmojiLike(msg, emojiLiker ? emojiLiker.toneOf(replyText) : 'neutral')
      : null;

    // 「有人找你」第 2 类（补充）：话发出去了，但她其实答不上来    //（回了「不知道」这种，或者又冒出自我定位的话）。
    if (!fromOwner && notifySvc && replyText) {
      const stuck = looksStuck(replyText);
      if (stuck) {
        notifySvc
          .maybe({
            kind: 'stuck',
            reason: `${msg.userName || msg.userId} 说「${text.slice(0, 30)}」，她回的是「${replyText.slice(0, 30)}」`,
            msg,
            window: isGroup ? `g:${msg.groupId}` : msg.userId,
            who: msg.userId,
          })
          .catch(() => {});
      }
    }

    repliesSinceSticker = sticker ? 0 : repliesSinceSticker + 1;

    return {
      reply: replyText,
      raw: reply,
      sticker: sticker ? sticker.name : undefined,
      stickerSent: stickerSent || undefined,
      emojiLike: emojiLiked ? emojiLiked.name : undefined,
      chunks,
      latencyMs,
      delays: paced ? delays : undefined,
      sent,
    };
  }

  /**
   * 定时扫一遍：哪个群的问题冷了、没人回，就主动答一句（main.js 每 tickSec 调一次）。
   * 靠它才能覆盖「问题发出后群里彻底没动静」这种情况。
   */
  async function tickAnswers() {
    if (groupAnswer.enabled === false) return [];
    const out = [];
    for (const [groupId, st] of groups) {
      const p = st.pending;
      if (!p || p.answeredAt) continue;
      if (modeStore?.isSilent()) continue;
      const ageMs = Date.now() - p.at;
      if (ageMs < (groupAnswer.coldSeconds ?? 180) * 1000) continue;
      if (answerBudget(st)) continue;
      const synth = {
        scene: 'group',
        groupId,
        msgId: p.msgId,
        userId: p.byId,
        userName: p.by,
        content: p.text,
        timestamp: p.at,
        mentioned: false,
        images: [],
        attachments: [],
        __answerNow: true,
      };
      try {
        const r = await handle(synth);
        out.push({ groupId, ...r });
      } catch (e) {
        // 失败也算「答过了」：不然后面每 tick 都会重试同一个问题，日志会被刷满、还白烧 token
        p.answeredAt = Date.now();
        p.oops = true;
        log?.warn?.('主动答题出错:', e.message);
      }
    }
    return out;
  }

  /**
   * 定时扫一遍：哪个群安静下来了，就自己起个新话头（参考最近聊天，但不接任何人的话）。
   * 用户要求：「让她自己开一个话题，可以参考之前的话题但是不要莫名其妙回复」。
   */
  async function tickTopic() {
    if (groupTopic.enabled === false) return [];
    if (modeStore?.isSilent?.()) return [];
    if (handoverStore?.isActive?.()) return [];
    const out = [];
    const now = Date.now();
    const bjNow = new Date(now + 8 * 3600 * 1000);
    const hour = bjNow.getUTCHours();
    const day = bjNow.toISOString().slice(0, 10);
    if (Array.isArray(groupTopic.quietHours) && groupTopic.quietHours.includes(hour)) return out;
    // 按时段取参数：中午少说、晚上多说（见 GROUP_TOPIC_DEFAULTS.timeWindows）
    const tp = topicParamsAt(groupTopic, hour);
    for (const [groupId, st] of groups) {
      if (!st.lines || st.lines.length < (tp.minMessages ?? 3)) continue;
      const lastMsgAt = st.lastMsgAt || 0;
      if (!lastMsgAt) continue;
      if (now - lastMsgAt < (tp.idleMinutes ?? 25) * 60000) continue;         // 还没冷场
      if (now - (st.lastTopicAt || 0) < (tp.minGapMinutes ?? 45) * 60000) continue; // 刚开过
      if (st.topicDay !== day) { st.topicDay = day; st.topicCount = 0; }
      if (st.topicCount >= (tp.maxPerDay ?? 6)) continue;
      if (!brain?.groupTopicFor || typeof bot?.sendGroup !== 'function') continue;
      try {
        const text = String(await brain.groupTopicFor({ lines: st.lines.slice(-12) }) || '').trim();
        if (!text) continue;
        // 和最近说过的话撞了就不发
        const win = (tp.dupWindowMinutes ?? 40) * 60000;
        if ((st.botLines || []).some((l) => now - l.at < win && simText(l.text, text) > 0.72)) {
          log?.info('[群里] 开话题撞上刚说过的，跳过');
          continue;
        }
        await bot.sendGroup(groupId, text);
        st.lastTopicAt = now;
        st.topicCount += 1;
        st.botLines = [...(st.botLines || []), { text, at: now }].slice(-20);
        rememberLine(groupId, BOT_NAME, text);
        if (groupLog) groupLog.record({ groupId, who: '我', text });
        log?.info(
          `[群里] 自己起了个话题（${groupDisplayName(groupId)}，${hour}点档·安静 ${Math.round((now - lastMsgAt) / 60000)} 分钟）：${text.slice(0, 30)}`
        );
        out.push({ groupId, topic: text });
      } catch (e) {
        log?.warn?.('主动开话题出错:', e.message);
        st.lastTopicAt = now; // 失败了也别每 tick 重试
      }
    }
    return out;
  }

  return { handle, handlePoke, tickAnswers, tickTopic, splitReply };
}

module.exports = { createResponder, splitReply, breakNatural, normalizeReply, PASSIVE_LIMIT, topicParamsAt, windowForHour };
