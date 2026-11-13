'use strict';
/**
 * 认「恶意」：判断一条消息是不是在骂它/找茬。
 *
 * 目的很具体：别人带着脏字冲它来的时候，不装听不见、也不讲大道理，
 * 直接用对方的词回敬一句（回嘴的规则写在 persona / 提示词里，这里只负责识别）。
 *
 * 判断标准（宁可漏，不要误伤）：
 *   1. 含有脏字/攻击性词（WORDS，可以在 config 里加 extraWords）
 *   2. 并且这句话是冲它来的：
 *      - 单聊：对方就是在跟它说话 → 算
 *      - 群里：@ 了它、句子里带了它的名字（水鸡/小D…），或者「你个 XX」这种直指对方
 * 另外：主人自己说话永远不算恶意（他骂它也是逗它）。
 */

const HOSTILE_DEFAULTS = {
  enabled: true,
  extraWords: [],
  bypassCooldown: true, // 骂到它头上时不吃群里的冷却/频率限制
};

/** 常见的中文脏字/攻击性词（尽量短，长词优先匹配） */
const WORDS = [
  // 骂人
  '傻逼', '傻b', '傻B', '煞笔', '沙比', 'sb', 'SB', 's13', 'nmsl', '脑残', '智障', '弱智',
  '白痴', '蠢货', '蠢死', '蠢猪', '废物', '废柴', '垃圾', '狗东西', '傻狗', '狗屎', '畜生',
  '贱人', '贱货', '有病吧', '神经病', '去死', '死开', '滚开', '滚蛋', '闭嘴', '恶心',
  '妈的', 'tmd', 'TMD', '他妈的', '你妈', '草泥马', 'fuck', 'shit', 'bitch',
];

/**
 * 拿病名骂人的那一类（最近的网络黑话）。
 * 「唐」本是姓氏/朝代/糖尿病，「糖」更是日常词，所以只在「成句成词」或「整条消息就只有它」时才算：
 *   唐氏 / 唐氏儿 / 唐完了 / 小唐人 / 糖人 / 糖完了 …
 */
const TAUNTS = [
  '唐氏综合征', '唐氏综合症', '唐氏儿', '唐氏宝宝', '唐氏', '唐完了', '唐儿', '唐得不行',
  '小唐人', '小糖人', '糖完了', '糖儿', '糖得不行', '糖氏', '唐宝', '唐牛', '唐人',
];

/** 整条消息就那么一个词（有人懒得打字，直接甩一个「糖」过来） */
const BARE_TAUNTS = ['糖', '唐', '糖糖', '唐唐', '糖人', '唐人', '糖丸', '唐丸', '唐完了', '糖完了', '唐氏', '糖氏'];

/** 「你个 XX」「你就是个 XX」这种直指对方的句式（群里不用 @ 也算冲它来）；第二组就是那半个词 */
const DIRECTED = /(你|您|汝|乃|你是|你个|你就是|你真是|你纯|你他妈|你丫)[^。！？!?\n]{0,8}(傻|蠢|弱|废|垃圾|狗|滚|闭嘴|恶心|有病|神经|脑残|智障|白痴|低能|没妈|去死|唐|糖)/;

function norm(text) {
  return String(text || '').replace(/\s+/g, '');
}

function stripPunct(text) {
  return norm(text).replace(/[。！!？?~～…、,，.:：;；"'“”‘’()（）\[\]【】]/g, '');
}

/** 整条消息就是个「糖/唐/唐完了」这种单个词（含叠字和标点） */
function isBareTaunt(text) {
  const s = stripPunct(text);
  if (!s || s.length > 6) return false;
  if (BARE_TAUNTS.includes(s)) return true;
  return TAUNTS.includes(s);
}

/** 找出这条消息里出现的攻击性词（去重、按长度倒序） */
function findInsults(text, cfg = {}) {
  const s = norm(text);
  if (!s) return [];
  const extra = (cfg.extraWords || []).filter(Boolean).map(String);
  const all = [...WORDS, ...TAUNTS, ...extra];
  const hit = new Set();
  for (const w of all) {
    const needle = w.toLowerCase();
    if (!needle) continue;
    if (s.toLowerCase().includes(needle)) hit.add(w);
  }
  if (isBareTaunt(text)) hit.add(stripPunct(text));
  const d = DIRECTED.exec(s);
  if (d && d[2]) hit.add(d[2]);
  return [...hit].sort((a, b) => b.length - a.length);
}

/**
 * @param {object} o
 * @param {string} o.text        这条消息的文字
 * @param {boolean} o.isGroup
 * @param {boolean} o.mentioned  群里是不是 @ 了它（qq.js 算的，含按名字认出）
 * @param {string[]} o.botNames  它自己的名字（水鸡/小D…）
 * @param {boolean} o.fromOwner  是不是主人本人说的
 * @returns {{hostile:boolean, words:string[], reason:string|null}}
 */
function detectHostile({ text = '', isGroup = false, mentioned = false, botNames = [], fromOwner = false } = {}) {
  if (fromOwner) return { hostile: false, words: [], reason: 'owner' };
  const words = findInsults(text);
  if (!words.length) return { hostile: false, words: [], reason: null };

  const s = norm(text);
  const named = (botNames || []).some((n) => n && s.includes(norm(n)));
  const directed = DIRECTED.test(s);
  const bare = isBareTaunt(text);

  if (!isGroup) return { hostile: true, words, reason: 'private' };
  if (mentioned || named) return { hostile: true, words, reason: 'at-me' };
  if (directed) return { hostile: true, words, reason: 'directed' };
  // 群里单甩一个「糖」「唐完了」这种：摆明了是在损它，不用 @ 也算
  if (bare) return { hostile: true, words, reason: 'taunt' };
  // 群里既没 @ 它、也没点名、也不是冲谁说的（比如「这游戏真垃圾」）→ 不插手
  return { hostile: false, words, reason: 'not-targeted' };
}

module.exports = { HOSTILE_DEFAULTS, WORDS, TAUNTS, BARE_TAUNTS, DIRECTED, norm, isBareTaunt, findInsults, detectHostile };
