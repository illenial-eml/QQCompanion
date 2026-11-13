'use strict';
/**
 * 确定性沉默：有些话不需要过模型。
 *
 * 「晚安」「我去上课了」「拜拜」这类收尾话，调一次模型要 1 秒 + 一份 token，
 * 换来的往往是「晚安，好梦」这种模板句——反而不像真人。
 * 这里用固定规则直接回，或者干脆不回。
 *
 * 两个规则：
 *   1) 收尾话 → 用一句很短的口语回（不调模型）
 *   2) 她刚回过收尾话的 5 分钟内，再来一句「晚安」→ 真的不回（免得「晚安」「晚安」「晚安」）
 */

const CLOSING = /^(?:晚安|晚安啦|晚安咯|睡了|去睡了|我睡了|我去睡了|先睡了|睡了睡了|困了|我困了|要睡了|睡觉了|拜拜|拜拜啦|再见|再见了|回见|88|886|我走了|走了|我先走了|出门了|我出门了|上课了|我去上课了|去上课了|去自习了|去吃饭了|吃饭去了|去忙了|我先忙了|忙去了|先这样|先这样吧|回头聊|下次聊|晚点聊|我下了|下线了|我下线了|挂了|先不聊了|不聊了|洗澡去了|我去洗澡了)[呀啊吧哦呢嘛。！!~～\s]*$/;

/** 她刚说完拜拜之后，这段时间内不再开口 */
const QUIET_AFTER_BYE_MS = 5 * 60 * 1000;

const REPLIES = {
  night: ['晚安', '嗯，晚安', '睡吧，明天再说', '晚安，做个好梦'],
  bye: ['拜拜', '嗯，去吧', '回见', '好，回头聊'],
  busy: ['去吧', '好，忙你的', '嗯，去吧', '行，去忙'],
  eat: ['去吧，好好吃', '嗯，吃饭去吧', '好，去吃吧'],
};

function isClosing(text) {
  return CLOSING.test(String(text || '').trim());
}

function kindOf(text) {
  const t = String(text || '');
  if (/晚安|睡|困/.test(t)) return 'night';
  if (/吃饭|吃去/.test(t)) return 'eat';
  if (/上课|自习|忙|洗澡|出门|走了/.test(t)) return 'busy';
  return 'bye';
}

/**
 * 回一句收尾话。返回 { text, quietMs }：
 *   text   —— 要发出去的话（空串表示不发）
 *   quietMs —— 接下来这么久之内，她不再接他的收尾话
 */
function closingReply(text, { rng = Math.random, lastReplyAt = 0, now = Date.now() } = {}) {
  if (now - Number(lastReplyAt || 0) < QUIET_AFTER_BYE_MS) {
    return { text: '', quietMs: QUIET_AFTER_BYE_MS - (now - lastReplyAt) };
  }
  const pool = REPLIES[kindOf(text)] || REPLIES.bye;
  const idx = Math.floor(rng() * pool.length) % pool.length;
  return { text: pool[idx], quietMs: QUIET_AFTER_BYE_MS };
}

/** 群里的收尾话：不接（她不是客服，不用跟每个人说晚安） */
function shouldStayQuietInGroup() {
  return true;
}

module.exports = { CLOSING, QUIET_AFTER_BYE_MS, REPLIES, isClosing, kindOf, closingReply, shouldStayQuietInGroup };
