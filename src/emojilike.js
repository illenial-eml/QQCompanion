'use strict';
/**
 * 贴表情（给某条消息点一个 QQ 小黄脸）
 *
 * 官方 QQ 机器人没有这个能力（只有频道支持 reaction），但小号走 NapCat 有：
 *   set_msg_emoji_like { message_id, emoji_id }
 * emoji_id 就是 QQ 经典小黄脸的表情 id（"13" = 呲牙，"14" = 惊讶 …）。
 *
 * 她的用法要像人：
 *   - 不是每条都贴，偶尔贴一下（概率 + 冷却 + 每日上限）
 *   - 贴的表情要和情绪对得上（好笑 → 呲牙/偷笑；无语 → 流汗/白眼；夸 → 赞/鼓掌）
 *   - 贴不上就算了，绝不影响正常回话
 */

/** QQ 经典小黄脸：id → 名字（只收常用的，够用） */
const FACE_NAME = {
  0: '微笑', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴',
  8: '睡', 9: '大哭', 10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙', 14: '惊讶', 15: '难过',
  16: '酷', 17: '冷汗', 18: '抓狂', 19: '吐', 20: '偷笑', 21: '可爱', 22: '白眼', 23: '傲慢',
  24: '饥饿', 25: '困', 26: '惊恐', 27: '流汗', 28: '憨笑', 29: '大兵', 30: '奋斗', 31: '咒骂',
  32: '疑问', 33: '嘘', 34: '晕', 35: '折磨', 36: '衰', 37: '骷髅', 38: '敲打', 39: '再见',
  40: '擦汗', 41: '抠鼻', 42: '鼓掌', 43: '糗大了', 44: '坏笑', 45: '左哼哼', 46: '右哼哼',
  47: '哈欠', 48: '鄙视', 49: '委屈', 50: '快哭了', 51: '阴险', 52: '亲亲', 53: '吓',
  54: '可怜', 55: '菜刀', 56: '西瓜', 57: '啤酒', 58: '篮球', 59: '乒乓', 60: '咖啡',
  61: '饭', 62: '猪头', 63: '玫瑰', 64: '凋谢', 65: '示爱', 66: '爱心', 67: '心碎',
  68: '蛋糕', 69: '闪电', 70: '炸弹', 71: '刀', 72: '足球', 73: '瓢虫', 74: '便便',
  75: '月亮', 76: '太阳', 77: '礼物', 78: '拥抱', 79: '强', 80: '弱', 81: '握手',
  82: '胜利', 83: '抱拳', 84: '勾引', 85: '拳头', 86: '差劲', 87: '爱你', 88: 'NO',
  89: 'OK', 90: '爱情', 91: '飞吻', 92: '跳跳', 93: '发抖', 94: '怄火', 95: '转圈',
  96: '磕头', 97: '回头', 98: '跳绳', 99: '挥手', 100: '激动', 101: '街舞', 102: '献吻',
  103: '左太极', 104: '右太极', 105: '双喜', 106: '鞭炮', 107: '灯笼', 108: 'K歌',
  109: '购物', 110: '邮件', 111: '帅', 112: '喝彩', 113: '祈祷', 114: '爆筋', 115: '棒棒糖',
  116: '喝奶', 118: '香蕉', 119: '飞机', 120: '开车', 121: '高铁', 122: '左车头',
  123: '车厢', 124: '右车头', 125: '多云', 126: '下雨', 127: '钞票', 128: '熊猫',
  129: '胶片', 130: '电影', 131: '彩虹', 132: '下雨', 133: '篮球', 134: '防毒面具',
  135: '汉堡', 136: '兔兔', 137: '爆头', 138: '吸血', 139: '捶地哭', 140: '睡觉',
  141: '口罩', 142: '流鼻血', 143: '月亮', 144: '灯泡', 145: '打哈欠', 146: '皱眉',
  147: '无语', 148: '奸笑', 149: '机智', 150: '狂笑', 151: '优雅', 152: '憨笑2',
  153: '泪汪汪', 154: '得意2', 155: '白眼2', 156: '嘘2', 157: '打脸', 158: '摸鱼',
  159: '鬼脸', 160: '吐舌', 161: '流口水', 162: '鄙视2', 163: '好委屈', 164: '哭晕',
  165: '呲牙2', 166: '困2', 167: '憨憨', 168: '口罩2', 169: '咒骂2', 170: '委屈2',
  171: '疑问2', 172: '晕2', 173: '尴尬2', 174: '发怒2', 175: '流泪2', 176: '微笑2',
  177: '嘿哈', 178: '捂脸', 179: '奸笑2', 180: '机智2', 181: '皱眉2', 182: '耶',
  183: '吃瓜', 184: '加油', 185: '汗', 186: '天啊', 187: '社会', 188: '碰拳', 189: '棒',
  190: '拜拜', 191: '不行', 192: '点赞', 193: '鼓掌2', 194: '比心', 195: '给力',
  196: '好的', 197: '谢谢', 198: '收到', 199: '举手', 200: '困觉', 201: '奋斗2',
  212: '托腮', 213: '星星眼', 214: '亲亲2', 215: '抱抱', 216: '摸头', 217: '打气',
  218: '求求了', 219: '哭', 220: '笑cry', 221: '裂开', 222: '狗头', 223: '敬礼',
  224: '思考', 225: '鼓掌3', 226: '赞', 227: '尴尬笑', 228: '哼', 229: '惊讶2',
  230: '叹气', 231: '委屈巴巴', 232: '加油2', 233: '比耶', 234: '心累', 235: '无语2',
};

/** 情绪 → 候选表情 id（按优先级） */
const TONES = {
  funny: [13, 20, 21, 178, 220],      // 呲牙/偷笑/可爱/捂脸/笑cry
  like: [76, 192, 226, 42, 79],       // 太阳(赞)/点赞/赞/鼓掌/强
  love: [66, 194, 63, 52],            // 爱心/比心/玫瑰/亲亲
  sad: [5, 49, 50, 219],              // 流泪/委屈/快哭了/哭
  speechless: [27, 40, 185, 235],     // 流汗/擦汗/汗/无语
  angry: [11, 31, 171],               // 发怒/咒骂/疑问
  shy: [6, 21, 199],                  // 害羞/可爱/举?
  hello: [76, 42],                    // 打招呼也点个赞
  neutral: [13, 20],
};

const EMOJI_LIKE_DEFAULTS = {
  enabled: true,
  probability: 0.18,      // 每回应一条，有多大概率顺手贴一个
  minGapSec: 90,          // 同一个会话（人或群）两次贴表情至少间隔
  maxPerDay: 60,          // 全账每日上限
  onlyWhenReply: true,    // 只有真的回了话才贴（PASS 时用另一条路）
  tones: {},              // 覆盖/微调：{ funny:[13,20], ... }
  faceNames: {},          // 覆盖 id→名字（校准用）
};

/** 从她刚说的话里猜情绪（不调模型，纯关键词，省算力） */
function toneOf(text) {
  const t = String(text || '');
  if (!t) return 'neutral';
  if (/[哈哈嘿嘿233]|笑死|好笑|逗[^人]|乐死|绷不住/.test(t)) return 'funny';
  if (/喜欢你|爱你|想你了|抱抱|亲亲|好可爱|么么/.test(t)) return 'love';
  if (/^(?:赞|棒|厉害|牛|强)|干得漂亮|好耶|可以啊/.test(t) || /夸|厉害|不错/.test(t)) return 'like';
  if (/难过|想哭|委屈|伤心|唉|可惜/.test(t)) return 'sad';
  if (/无语|流汗|离谱|无语子|服了|醉了/.test(t)) return 'speechless';
  if (/滚|闭嘴|烦死|生气|讨厌|傻|蠢/.test(t)) return 'angry';
  if (/害羞|不好意思|别夸/.test(t)) return 'shy';
  return 'neutral';
}

function createEmojiLiker({ client, cfg = {}, log = null, now = () => Date.now() } = {}) {
  const conf = { ...EMOJI_LIKE_DEFAULTS, ...(cfg || {}) };
  const tones = { ...TONES };
  for (const [k, v] of Object.entries(conf.tones || {})) {
    if (Array.isArray(v) && v.length) tones[k] = v.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  }
  const names = { ...FACE_NAME, ...(conf.faceNames || {}) };

  let dayKey = '';
  let dayCount = 0;
  const lastAt = new Map(); // 会话 key → 上次贴的时间

  function todayKey() {
    const d = new Date(now() + 8 * 3600000);
    return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
  }

  function faceName(id) {
    return names[Number(id)] || String(id);
  }

  /** 这条消息现在能不能贴：返回 null 表示可以，否则返回原因 */
  function budget(sessionKey) {
    if (conf.enabled === false) return 'emoji-off';
    if (!client || typeof client.setMsgEmojiLike !== 'function') return 'emoji-unsupported';
    const k = todayKey();
    if (k !== dayKey) { dayKey = k; dayCount = 0; }
    if (dayCount >= (conf.maxPerDay ?? 60)) return 'emoji-day-limit';
    const gap = (conf.minGapSec ?? 90) * 1000;
    const last = lastAt.get(String(sessionKey || '')) || 0;
    if (last && now() - last < gap) return 'emoji-cooldown';
    return null;
  }

  /**
   * 贴一个表情到某条消息上。
   * tone: funny/like/love/sad/speechless/angry/shy/hello/neutral
   * 返回 { ok, id, name, reason }
   */
  async function like(msgId, { tone = 'neutral', sessionKey = '', force = false, probability = null, rng = Math.random } = {}) {
    if (!msgId) return { ok: false, reason: 'no-msgid' };
    const why = budget(sessionKey);
    if (why && !force) return { ok: false, reason: why };
    const p = probability == null ? (conf.probability ?? 0.18) : Number(probability);
    if (!force && p < 1 && rng() > p) return { ok: false, reason: 'emoji-skip' };
    const pool = tones[tone] || tones.neutral;
    const id = pool[Math.floor(rng() * pool.length)];
    try {
      const r = await client.setMsgEmojiLike(msgId, String(id), { set: true });
      if (!r || r.ok === false) {
        log?.debug?.(`贴表情失败（${id}）：${r?.message || r?.reason || ''}`);
        return { ok: false, id, reason: r?.message || 'api-failed' };
      }
      dayCount += 1;
      lastAt.set(String(sessionKey || ''), now());
      log?.info?.(`贴了个表情「${faceName(id)}」在 ${String(msgId).slice(0, 8)}…（${tone}）`);
      return { ok: true, id, name: faceName(id) };
    } catch (e) {
      log?.debug?.(`贴表情抛错：${e.message}`);
      return { ok: false, id, reason: e.message };
    }
  }

  return { like, budget, toneOf, faceName, settings: conf };
}

module.exports = { EMOJI_LIKE_DEFAULTS, FACE_NAME, TONES, createEmojiLiker, toneOf };
