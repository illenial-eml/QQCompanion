// 群里主动答题（groupAnswer）测试
// 跑法：node test/group-answer.js
const { createResponder } = require('../src/responder');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name); }
}

const cfg = {
  qq: {
    botNames: ['鸿'],
    allowGroups: [],
    allowFrom: [],
    replyInGroup: true,
    maxReplyChars: 1500,
    groupAuto: { enabled: true, mode: 'keywords', keywords: ['鸿'], minIntervalSec: 1, maxPerHour: 99, contextSize: 8, reactWithSticker: false },
    groupAnswer: { enabled: true, atQuestioner: false, hotReplies: 3, coldSeconds: 180, cooldownSec: 0, maxPerHour: 99, minChars: 6, tickSec: 30 },
  },
  sticker: { enabled: false },
  brain: {},
  rhythm: { mergeWindowMs: 0 },
  modes: {},
};

// 测试用绝对时间：/src/responder.js 内部大量直接调 Date.now()（不是注入的 now），
// 所以单靠移动注入的 now 指针让问题「变冷」是无效的，必须让 Date.now 本身往前走。
// 注意：responder 在 require 时不会缓存 Date.now，运行时替换即可。
let absNow = Date.now();
const realDateNow = Date.now;
Date.now = () => absNow;
const sent = [];
const bot = {
  async sendGroup(groupId, content) { sent.push({ groupId, content }); return { id: 'm' + sent.length }; },
  async sendC2C() { return { id: 'c' }; },
  canSend() { return true; },
  stats() { return {}; },
};

const brain = {
  async chat() { return '大概是开学季吧'; },
  async complete() { return '大概是开学季吧'; },
  reqCount: 0,
};

function makeNow(offset) {
  return () => absNow + offset;
}

function makeResponder(nowRef) {
  return createResponder({
    cfg,
    bot,
    brain: {
      ...brain,
      chat: async () => { brain.reqCount += 1; return '大概是开学季吧'; },
    },
    memory: null,
    stickers: null,
    log: { info() {}, warn() {}, debug() {}, error() {}, trace() {} },
    now: nowRef,
  });
}

async function main() {
  console.log('群里主动答题');

  // --- 用例1：问题刚出现，这一轮不答 ---
  {
    sent.length = 0;
    const r = makeResponder(makeNow(0));
    const out = await r.handle({
      scene: 'group', groupId: 'g1', msgId: 'q1', userId: 'u1', userName: '小明',
      content: '有没有人知道这个报错怎么回事', timestamp: absNow, mentioned: false,
    });
    ok('刚问出来的问题这一轮不答', out && out.skipped);
    ok('这一轮没发消息', sent.length === 0);
  }

  // --- 用例2：冷了 181 秒后，定时扫描会主动答 ---
  {
    sent.length = 0;
    let now = absNow;
    const r = makeResponder(() => now);
    await r.handle({
      scene: 'group', groupId: 'g2', msgId: 'q2', userId: 'u1', userName: '小明',
      content: '有没有人知道这个报错怎么回事', timestamp: now, mentioned: false,
    });
    now += 181 * 1000;
    absNow += 181 * 1000;
  
    const res = await r.tickAnswers();
    ok('定时扫描返回了作答结果', Array.isArray(res) && res.length === 1);
    ok('冷场问题被回答了（发出 1 条）', sent.length >= 1);
    ok('回答里没有 <@openid> 代码', !sent.some((s) => s.content.includes('<@')));
  }

  // --- 用例3：冷场时间不够，不答 ---
  {
    sent.length = 0;
    let now = absNow;
    const r = makeResponder(() => now);
    await r.handle({
      scene: 'group', groupId: 'g3', msgId: 'q3', userId: 'u1', userName: '小明',
      content: '有没有人知道这个报错怎么回事', timestamp: now, mentioned: false,
    });
    now += 60 * 1000;
    absNow += 60 * 1000;
    const res = await r.tickAnswers();
    ok('只冷了 60 秒不答', Array.isArray(res) && res.length === 0);
  }

  // --- 用例4：不是问题的话，不会被当成冷场问题 ---
  {
    sent.length = 0;
    let now = absNow;
    const r = makeResponder(() => now);
    await r.handle({
      scene: 'group', groupId: 'g4', msgId: 'q4', userId: 'u1', userName: '小明',
      content: '今天天气真好呀我们在外面玩', timestamp: now, mentioned: false,
    });
    now += 181 * 1000;
    absNow += 181 * 1000;
  
    const res = await r.tickAnswers();
    ok('闲聊不算问题，不会主动答', Array.isArray(res) && res.length === 0);
  }

  // --- 用例5：短问题（少于 minChars）不算 ---
  {
    sent.length = 0;
    let now = absNow;
    const r = makeResponder(() => now);
    await r.handle({
      scene: 'group', groupId: 'g5', msgId: 'q5', userId: 'u1', userName: '小明',
      content: '咋办', timestamp: now, mentioned: false,
    });
    now += 181 * 1000;
    absNow += 181 * 1000;
  
    const res = await r.tickAnswers();
    ok('太短的问题（咋办）不算正经问题', Array.isArray(res) && res.length === 0);
  }

  // --- 用例6：enabled=false 时整个关掉 ---
  {
    sent.length = 0;
    let now = absNow;
    const r = createResponder({
      cfg: { ...cfg, qq: { ...cfg.qq, allowFrom: [], replyInGroup: true, groupAnswer: { ...cfg.qq.groupAnswer, enabled: false } } },
      bot,
      brain,
      memory: null,
      stickers: null,
      log: { info() {}, warn() {}, debug() {}, error() {}, trace() {} },
      now: () => now,
    });
    await r.handle({
      scene: 'group', groupId: 'g6', msgId: 'q6', userId: 'u1', userName: '小明',
      content: '有没有人知道这个报错怎么回事', timestamp: now, mentioned: false,
    });
    now += 181 * 1000;
    absNow += 181 * 1000;
  
    const res = await r.tickAnswers();
    ok('groupAnswer.enabled=false 时定时扫描直接返回空', Array.isArray(res) && res.length === 0);
  }

  // --- 用例7：答过一次后，同一时间窗口不会反复答 ---
  {
    sent.length = 0;
    let now = absNow;
    const r = createResponder({
      cfg: { ...cfg, qq: { ...cfg.qq, allowFrom: [], replyInGroup: true, groupAnswer: { ...cfg.qq.groupAnswer, cooldownSec: 300 } } },
      bot,
      brain,
      memory: null,
      stickers: null,
      log: { info() {}, warn() {}, debug() {}, error() {}, trace() {} },
      now: () => now,
    });
    await r.handle({
      scene: 'group', groupId: 'g7', msgId: 'q7', userId: 'u1', userName: '小明',
      content: '有没有人知道这个报错怎么回事', timestamp: now, mentioned: false,
    });
    now += 181 * 1000;
    absNow += 181 * 1000;
    await r.tickAnswers();
    const firstCount = sent.length;
    // 又过了 5 分钟，中间没人说话：同一道题写进历史也只需答一次，不该每 tick 都重答
    for (let i = 0; i < 5; i += 1) {
      now += 60 * 1000;
      absNow += 60 * 1000;
      await r.tickAnswers();
    }
    ok('同一道题答过之后不会反复答', sent.length === firstCount);
  }

  console.log('通过 ' + pass + ' 项' + (fail ? '，失败 ' + fail + ' 项' : ''));
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error('测试崩了:', e);
  process.exit(1);
});
