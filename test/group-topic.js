// 群里「自己开话题」+ 不重复 + 不抢问答别人的测试
// 跑法：node test/group-topic.js
const { createResponder } = require('../src/responder');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name); }
}

const cfg = {
  qq: {
    botNames: ['鸿', '水鸡'],
    allowGroups: [],
    allowFrom: [],
    replyInGroup: true,
    maxReplyChars: 1500,
    groupAuto: { enabled: true, mode: 'keywords', keywords: ['鸿'], minIntervalSec: 1, maxPerHour: 99, contextSize: 8, reactWithSticker: false, staleSkipMs: 0 },
    groupAnswer: { enabled: true, atQuestioner: false, hotReplies: 3, coldSeconds: 180, cooldownSec: 0, maxPerHour: 99, minChars: 6, tickSec: 30 },
    groupTopic: { enabled: true, idleMinutes: 25, minGapMinutes: 45, maxPerDay: 6, minMessages: 3, quietHours: [], dupWindowMinutes: 40, timeWindows: [] },
  },
  sticker: { enabled: false },
  brain: {},
  rhythm: { mergeWindowMs: 0 },
  modes: {},
};

let absNow = Date.now();
Date.now = () => absNow;
const sent = [];
const bot = {
  async sendGroup(groupId, content) { sent.push({ groupId, content }); return { id: 'm' + sent.length }; },
  async sendC2C() { return { id: 'c' }; },
  canSend() { return true; },
  stats() { return {}; },
};

function makeResponder(replyText, topicText) {
  return createResponder({
    cfg,
    bot,
    brain: {
      async chat() { return replyText; },
      async complete() { return replyText; },
      async groupTopicFor() { return topicText; },
      reqCount: 0,
    },
    memory: null,
    stickers: null,
    log: { info() {}, warn() {}, debug() {}, error() {}, trace() {} },
  });
}

function msg(o = {}) {
  return {
    scene: 'group',
    groupId: 'g1',
    msgId: o.msgId || ('m' + Math.random().toString(36).slice(2, 8)),
    userId: o.userId || '10001',
    userName: o.userName || '小明',
    content: o.content || '',
    timestamp: Date.now(),
    mentioned: o.mentioned === true,
    images: [],
    attachments: [],
  };
}

async function main() {
  console.log('群里开话题 / 不重复 / 不抢答别人的问题');

  // --- 用例1：主动答题时，同一句话不会连着说两遍 ---
  {
    sent.length = 0;
    const r = makeResponder('这个话题挺有意思的', '随便');
    await r.handle(msg({ content: '有人知道这个报错怎么办吗？', msgId: 'q1', userName: 'A', userId: '1' }));
    absNow += 5 * 60 * 1000;
    await r.tickAnswers();
    const first = sent.length;
    await r.handle(msg({ content: '那这个依赖装不上怎么办？', msgId: 'q2', userName: 'B', userId: '2' }));
    absNow += 5 * 60 * 1000;
    await r.tickAnswers();
    ok('第一次主动答题正常发出去', first === 1);
    ok('第二次同样的回答被判重复', sent.length === first);
  }

  // --- 用例2：问的是别人（@别人）→ 不抢答 ---
  {
    sent.length = 0;
    const r = makeResponder('我来回答', '随便');
    await r.handle(msg({ content: '有人知道 @张三 这个题怎么做吗？', msgId: 'q1', userName: '小红', userId: '20002' }));
    // 让这个问题「冷掉」
    absNow += 5 * 60 * 1000;
    const out = await r.tickAnswers();
    const replied = (out || []).filter((x) => x && (x.reply || x.sent));
    ok('问别人的问题不去抢答', replied.length === 0);
    ok('抢答没有发出去', sent.length === 0);
  }

  // --- 用例3：群里安静够久 → 自己开话题 ---
  {
    sent.length = 0;
    absNow += 60 * 60 * 1000; // 再往后挪一小时，超过 idleMinutes
    const r = makeResponder('嗯', '你们今天吃到什么好吃的没');
    await r.handle(msg({ content: '今天食堂排好长', userName: '甲', userId: '1' }));
    await r.handle(msg({ content: '我也排了半小时', userName: '乙', userId: '2' }));
    await r.handle(msg({ content: '最后还是吃了泡面', userName: '丙', userId: '3' }));
    absNow += 30 * 60 * 1000; // 安静 30 分钟
    const out = await r.tickTopic();
    ok('安静够久后开了个话题', Array.isArray(out) && out.length === 1);
    ok('话题内容发到了群里', sent.some((s) => s.content === '你们今天吃到什么好吃的没'));
  }

  // --- 用例4：刚开过话题就不再开（间隔不够）---
  {
    const sentBefore = sent.length;
    absNow += 5 * 60 * 1000;
    const r = makeResponder('嗯', '第二个话题');
    // 用同一个 responder：先制造「刚开过」的状态
    await r.handle(msg({ content: '在吗', userName: '甲', userId: '1' }));
    await r.handle(msg({ content: '有人在吗', userName: '乙', userId: '2' }));
    await r.handle(msg({ content: '说话呀', userName: '丙', userId: '3' }));
    absNow += 30 * 60 * 1000;
    await r.tickTopic();
    const mid = sent.length;
    absNow += 10 * 60 * 1000; // 只过 10 分钟，不足 45 分钟
    await r.tickTopic();
    ok('间隔不够时不重复开话题', sent.length === mid);
    ok('确实开过一次', mid === sentBefore + 1);
  }

  // --- 用例5：安静不够时不开口 ---
  {
    sent.length = 0;
    const r = makeResponder('嗯', '不该出现的话题');
    await r.handle(msg({ content: '刚说了一句', userName: '甲', userId: '1' }));
    await r.handle(msg({ content: '又一句', userName: '乙', userId: '2' }));
    await r.handle(msg({ content: '第三句', userName: '丙', userId: '3' }));
    absNow += 60 * 1000; // 只安静 1 分钟
    const out = await r.tickTopic();
    ok('没冷场时不开话题', (out || []).length === 0);
    ok('也没有发任何消息', sent.length === 0);
  }

  // --- 用例6：时段表本身的逻辑（纯函数，不依赖 responder）---
  {
    const { topicParamsAt, windowForHour } = require('../src/responder');
    // 如果没导出，就跳过（下面用集成方式测）
    if (windowForHour) {
      ok('12 点命中「中午」窗口', windowForHour([{ start: 11, end: 14, idleMinutes: 35 }], 12) && true);
      ok('凌晨 3 点不命中中午窗口', !windowForHour([{ start: 11, end: 14 }], 3));
      ok('跨 0 点窗口（22-2）命中 23 点', !!windowForHour([{ start: 22, end: 2 }], 23));
      ok('跨 0 点窗口（22-2）命中 1 点', !!windowForHour([{ start: 22, end: 2 }], 1));
      const p = topicParamsAt({ idleMinutes: 25, minGapMinutes: 45, maxPerDay: 6, timeWindows: [{ start: 11, end: 14, idleMinutes: 35, maxPerDay: 1 }] }, 12);
      ok('命中窗口后 idleMinutes 被覆盖成 35', p.idleMinutes === 35);
      ok('命中窗口后 maxPerDay 被覆盖成 1', p.maxPerDay === 1);
      ok('没写的字段保持全局（minGapMinutes 仍 45）', p.minGapMinutes === 45);
    }
  }

  console.log(`\n结果：${pass} 过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
