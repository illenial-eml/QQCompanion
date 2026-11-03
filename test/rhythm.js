'use strict';
/**
 * 真人节奏测试（不联网、不调模型）：
 *   1. 按句子拆气泡：短句合并、太长并回一条、不丢字
 *   2. 打字/停顿延迟：第一条有「看手机 + 打字」延迟，之后是停顿，且都在配置范围内
 *   3. 连发合并器：等你把话说完再回
 *   4. responder 走节奏：一条回复拆成几条短消息、消息用递增 msg_seq、总时长可控
 *   5. 拆得太碎时回退到普通分段（不烧干被动回复额度）
 */
const assert = require('node:assert');
const { createResponder, splitReply } = require('../src/responder');
const {
  splitSentences, splitBubbles, bubbleDelays, createBurstMerger, mergeMessages, RHYTHM_DEFAULTS,
} = require('../src/rhythm');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 记录 sleep 而不真的等 */
function recorder() {
  const waits = [];
  return { waits, sleepFn: async (ms) => { waits.push(ms); } };
}

function fakeCfg(rhythm = {}) {
  return {
    qq: { allowFrom: [], replyInGroup: true, maxReplyChars: 100, typing: false },
    brain: {},
    rhythm: { ...RHYTHM_DEFAULTS, ...rhythm },
  };
}

function fakeBot() {
  const calls = [];
  return {
    calls,
    async sendC2C(id, content, { msgId, msgSeq }) {
      calls.push({ kind: 'c2c', id, content, msgId, msgSeq });
      return { id: 'ok' };
    },
    async sendGroup(id, content, { msgId, msgSeq }) {
      calls.push({ kind: 'group', id, content, msgId, msgSeq });
      return { id: 'ok' };
    },
    async sendTyping() { return { ok: true }; },
  };
}

// 注意别用「在吗」——那是 ping 指令，会走轻量分支
const msg = (content = '今天有点累') => ({
  scene: 'c2c', userId: 'U1', userName: '小明', msgId: 'M1', content,
});

(async () => {
  // 1. 切句
  {
    assert.deepEqual(splitSentences('在呢。今天忙不忙？还行……'), ['在呢。', '今天忙不忙？', '还行……']);
    assert.deepEqual(splitSentences('第一行\n第二行'), ['第一行', '第二行']);
    assert.deepEqual(splitSentences(''), []);
    console.log('✓ 句子切分：句号/问号/省略号/换行');
  }

  // 2. 拆气泡：短句合并，长句不拆，超上限并到最后一条
  {
    assert.deepEqual(splitBubbles('在呢。', {}), ['在呢。'], '只有一句就是一条');
    const three = splitBubbles('在呢。今天忙不忙？要不要早点睡。', { maxCharsPerBubble: 50, maxBubbles: 3 });
    assert.equal(three.length, 3);

    const four = '一。二。三。四。';
    const two = splitBubbles(four, { maxCharsPerBubble: 2, maxBubbles: 2 });
    assert.equal(two.length, 2, '超过 maxBubbles 要并回去');
    assert.equal(two.join(''), four, '并回去不能丢字');

    const oneLong = '啊'.repeat(120);
    assert.deepEqual(splitBubbles(oneLong, { maxCharsPerBubble: 20 }), [oneLong], '没有标点的长句不硬拆');
    console.log('✓ 气泡拆分：合并短句 / 不丢字 / 长句不拆');
  }

  // 3. 延迟范围
  {
    const bubbles = ['在呢。', '今天忙不忙？吃了吗？'];
    const rng = () => 0.5;
    const delays = bubbleDelays(bubbles, RHYTHM_DEFAULTS, rng);
    assert.equal(delays.length, 2);

    const firstMin = RHYTHM_DEFAULTS.readDelayMinMs + 250;
    const firstMax = RHYTHM_DEFAULTS.readDelayMaxMs + 2000;
    assert.ok(delays[0] >= firstMin && delays[0] <= firstMax, `第一条延迟应在 ${firstMin}-${firstMax}，实际 ${delays[0]}`);
    assert.ok(delays[1] >= RHYTHM_DEFAULTS.bubbleGapMinMs && delays[1] <= RHYTHM_DEFAULTS.bubbleGapMaxMs + 200,
      `后续停顿应在范围内，实际 ${delays[1]}`);

    // 句子越长，估算的打字时间越久（但会被 typingMaxMs 封顶）
    const shortGap = bubbleDelays(['短。', '短句。'], RHYTHM_DEFAULTS, rng)[1];
    const longGap = bubbleDelays(['短。', '这是一条很长的句子' + '啊'.repeat(80) + '。'], RHYTHM_DEFAULTS, rng)[1];
    assert.ok(longGap > shortGap, '长句停顿应该更久');
    assert.ok(longGap <= RHYTHM_DEFAULTS.bubbleGapMaxMs + 200, '停顿有上限，不会等太久');
    console.log(`✓ 延迟：第一条 ${delays[0]}ms（看手机+打字），短句停顿 ${shortGap}ms / 长句 ${longGap}ms`);
  }

  // 4. 连发合并器
  {
    const flushed = [];
    const m = createBurstMerger({
      windowMs: 40, maxWaitMs: 200,
      merge: mergeMessages,
      onFlush: (key, merged, items) => flushed.push({ key, merged, count: items.length }),
    });
    m.push('U1', { ...msg(), msgId: 'B1', content: '我今天' });
    m.push('U1', { ...msg(), msgId: 'B2', content: '被老板骂了' });
    m.push('U1', { ...msg(), msgId: 'B3', content: '烦死' });
    assert.equal(m.pending(), 1);
    assert.equal(flushed.length, 0, '还在等你把话说完');
    await sleep(120);
    assert.equal(flushed.length, 1, '只回一轮');
    assert.equal(flushed[0].count, 3);
    assert.equal(flushed[0].merged.content, '我今天\n被老板骂了\n烦死');
    assert.equal(flushed[0].merged.msgId, 'B3', '用最新那条的 msg_id 做被动回复');
    console.log('✓ 连发合并：3 条消息合成 1 轮，用最新 msg_id 回');
  }

  // 5. 合并时忽略非文字（图片）内容
  {
    const merged = mergeMessages([
      { msgId: 'a', content: '看这个' },
      { msgId: 'b', content: '', attachments: [{ content_type: 'image/png' }] },
    ]);
    assert.equal(merged.content, '看这个');
    console.log('✓ 合并时空内容（图片）不会污染文字');
  }

  // 6. responder 走节奏：拆成 3 条、递增 msg_seq、有停顿
  {
    const bot = fakeBot();
    const { waits, sleepFn } = recorder();
    const brain = { chat: async () => '在呢。今天咋了？吃了吗？' };
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog, sleepFn, rng: () => 0.5 });
    const res = await r.handle(msg());
    assert.equal(bot.calls.length, 3, '应该拆成 3 条发');
    assert.deepEqual(bot.calls.map((c) => c.msgSeq), [1, 2, 3]);
    assert.ok(bot.calls.every((c) => c.msgId === 'M1'), '都走被动回复');
    assert.equal(waits.length, 3, '每条前面都有停顿（包括第一条）');
    assert.equal(res.delays.length, 3);
    assert.equal(res.chunks.join(''), '在呢。今天咋了？吃了吗？');
    console.log(`✓ 节奏发送：3 条短消息，停顿 ${waits.map((w) => Math.round(w)).join('/')}ms`);
  }

  // 7. 关掉节奏就还是一整段
  {
    const bot = fakeBot();
    const { waits, sleepFn } = recorder();
    const brain = { chat: async () => '在呢。今天咋了？吃了吗？' };
    const r = createResponder({
      cfg: fakeCfg({ enabled: false }), bot, brain, log: silentLog, sleepFn, rng: () => 0.5,
    });
    const res = await r.handle(msg());
    assert.equal(bot.calls.length, 1, '关掉节奏一条发完');
    assert.equal(waits.length, 0, '第一条不等');
    assert.equal(res.chunks.length, 1);
    console.log('✓ 关闭节奏：一次发完，无延迟');
  }

  // 8. 群聊不套节奏（群里一条一条蹦太吵）
  {
    const bot = fakeBot();
    const { waits, sleepFn } = recorder();
    const brain = { chat: async () => '这句还行。这句也可以。' };
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog, sleepFn, rng: () => 0.5 });
    await r.handle({
      scene: 'group', groupId: 'G1', userId: 'U2', userName: '小明',
      msgId: 'GM1', content: '有人吗', mentioned: true,
    });
    assert.equal(waits.filter((w) => w > 0).length, 0, '群聊不加打字停顿');
    console.log('✓ 群聊不加节奏（只在私聊用）');
  }

  // 9. 拆得太碎时回退普通分段，保住被动额度
  {
    const bot = fakeBot();
    const { sleepFn } = recorder();
    const many = Array.from({ length: 12 }, (_, i) => `第${i + 1}句说点什么呢` + '啊'.repeat(22) + '。').join('');
    const r = createResponder({
      cfg: fakeCfg({ maxBubbles: 3 }), bot, brain: { chat: async () => many }, log: silentLog, sleepFn, rng: () => 0.5,
    });
    const res = await r.handle(msg());
    assert.equal(res.chunks.length, splitReply(many, 100).length, '回退成普通分段');
    const passive = bot.calls.filter((c) => c.msgId).length;
    assert.ok(passive <= 4, '被动回复不超过 4 条');
    console.log(`✓ 拆太碎时回退：${res.chunks.length} 段，被动 ${passive} 条`);
  }

  console.log('\n真人节奏测试全部通过 ✅');
})().catch((e) => { console.error('✗ 测试失败:', e.message); console.error(e.stack); process.exit(1); });
