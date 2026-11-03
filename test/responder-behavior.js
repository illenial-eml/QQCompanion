'use strict';
/**
 * responder 行为测试（不联网、不调模型）：
 *   1. 被动回复失败 -> 自动降级成主动消息重试
 *   2. 40054005（重复 msg_id+msg_seq）视为已发送，不再重发
 *   3. 白名单过滤 / 群开关 / 非文字消息提示 / ping
 *   4. 长回复分段且每段不超过上限
 */
const assert = require('node:assert');
const { createResponder, splitReply } = require('../src/responder');

function fakeCfg(over = {}) {
  return {
    qq: { allowFrom: [], replyInGroup: true, maxReplyChars: 100, typing: false, ...over },
    brain: {},
    rhythm: { enabled: false },
  };
}

function fakeBot({ failPassive = false, failCode = 40034128 } = {}) {
  const calls = [];
  const err = (code) => Object.assign(new Error('boom ' + code), { errCode: code });
  return {
    calls,
    async sendC2C(id, content, { msgId }) {
      calls.push({ kind: 'c2c', id, content, msgId });
      if (!msgId) return { id: 'active' };
      if (failPassive) throw err(failCode);
      return { id: 'passive' };
    },
    async sendGroup(id, content, { msgId }) {
      calls.push({ kind: 'group', id, content, msgId });
      return { id: msgId ? 'passive' : 'active' };
    },
    async sendTyping() { return { ok: true }; },
  };
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const msg = { scene: 'c2c', userId: 'U1', userName: '小明', msgId: 'M1', content: '你好呀' };

(async () => {
  // 1. 正常被动回复
  {
    const bot = fakeBot();
    const brain = { chat: async () => '在呢' };
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog });
    const res = await r.handle({ ...msg });
    assert.equal(bot.calls.length, 1);
    assert.equal(bot.calls[0].msgId, 'M1');
    assert.equal(res.sent[0].passive, true);
    console.log('✓ 被动回复带 msg_id');
  }

  // 2. 被动失败 -> 主动降级
  {
    const bot = fakeBot({ failPassive: true });
    const brain = { chat: async () => '在呢' };
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog });
    const res = await r.handle({ ...msg });
    assert.equal(bot.calls.length, 2, '应该先试被动再试主动');
    assert.equal(bot.calls[0].msgId, 'M1');
    assert.equal(bot.calls[1].msgId, undefined);
    assert.equal(res.sent[0].passive, false);
    assert.equal(res.sent[0].ok, true);
    console.log('✓ 被动失败自动降级为主动消息');
  }

  // 3. 40054005 重复 -> 视为成功，不重发
  {
    const bot = fakeBot({ failPassive: true, failCode: 40054005 });
    const brain = { chat: async () => '在呢' };
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog });
    const res = await r.handle({ ...msg });
    assert.equal(bot.calls.length, 1, '40054005 不应该触发主动重发');
    assert.equal(res.sent[0].ok, true);
    console.log('✓ 40054005 重复发送不重发');
  }

  // 4. 白名单
  {
    const bot = fakeBot();
    const brain = { chat: async () => { throw new Error('不该被调用'); } };
    const r = createResponder({ cfg: fakeCfg({ allowFrom: ['OTHER'] }), bot, brain, log: silentLog });
    const res = await r.handle({ ...msg });
    assert.equal(res.skipped, 'not-allowed');
    assert.equal(bot.calls.length, 0);
    console.log('✓ 白名单外的人被忽略');
  }

  // 5. 群开关
  {
    const bot = fakeBot();
    const r = createResponder({
      cfg: fakeCfg({ replyInGroup: false }), bot, brain: { chat: async () => 'x' }, log: silentLog,
    });
    const res = await r.handle({ scene: 'group', userId: 'U2', groupId: 'G1', msgId: 'M2', content: '群里的消息' });
    assert.equal(res.skipped, 'group-off');
    console.log('✓ 关闭群回复后群里不回');
  }

  // 6. 非文字消息给个提示
  {
    const bot = fakeBot();
    const r = createResponder({ cfg: fakeCfg(), bot, brain: { chat: async () => 'x' }, log: silentLog });
    const res = await r.handle({ ...msg, content: '', attachments: [{ content_type: 'image/png' }] });
    assert.equal(res.skipped, 'empty');
    assert.equal(bot.calls.length, 1);
    assert.match(bot.calls[0].content, /看不了/);
    console.log('✓ 图片消息有兜底提示');
  }

  // 7. ping
  {
    const bot = fakeBot();
    const r = createResponder({ cfg: fakeCfg(), bot, brain: { chat: async () => 'x' }, log: silentLog });
    await r.handle({ ...msg, content: 'ping' });
    assert.equal(bot.calls[0].content, '在。');
    console.log('✓ ping 走轻量指令');
  }

  // 8. 模型调用失败有兜底
  {
    const bot = fakeBot();
    const r = createResponder({
      cfg: fakeCfg(), bot, brain: { chat: async () => { throw new Error('timeout'); } }, log: silentLog,
    });
    const res = await r.handle({ ...msg });
    assert.equal(res.error, 'timeout');
    assert.match(bot.calls[0].content, /卡了一下/);
    console.log('✓ 模型失败有兜底回复');
  }

  // 9. 长回复分段
  {
    const bot = fakeBot();
    const long = Array.from({ length: 30 }, (_, i) => `第${i + 1}句话，说点什么呢。`).join('');
    const brain = { chat: async () => long };
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog });
    await r.handle({ ...msg, content: '你多说点' });
    assert.ok(bot.calls.length > 1, '长回复应该分段');
    for (const c of bot.calls) assert.ok(c.content.length <= 100, '每段不超过 100 字');
    const rejoined = bot.calls.map((c) => c.content).join('');
    assert.equal(rejoined.length, long.length, '分段后总长度不变（没丢字）');
    const passiveCount = bot.calls.filter((c) => c.msgId).length;
    assert.ok(passiveCount <= 4, '被动回复不超过 4 条');
    console.log(`✓ 长回复分 ${bot.calls.length} 段，其中被动 ${passiveCount} 条，主动 ${bot.calls.length - passiveCount} 条`);
  }

  // 10. 标点不被丢
  {
    const chunks = splitReply('啊'.repeat(99) + '。' + '吧'.repeat(50), 100);
    assert.ok(!chunks[1].startsWith('。'), '下一段不该以句号开头');
    console.log('✓ 断句不丢标点');
  }

  console.log('\nresponder 全部行为测试通过 ✅');
})().catch((e) => { console.error('✗ 测试失败:', e.message); process.exit(1); });
