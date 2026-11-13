'use strict';
// 第 2 期测试：确定性沉默 / 情绪有原因 / 纪念日
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isClosing, kindOf, closingReply, QUIET_AFTER_BYE_MS } = require('../src/silence');
const { createSelfState } = require('../src/selfstate');
const { createInnerLife } = require('../src/innerlife');

let pass = 0;
let fail = 0;
async function ok(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ': ' + e.message);
  }
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-'));

function tmp(name) {
  return path.join(TMP, name + '-' + Math.random().toString(36).slice(2) + '.json');
}

(async () => {
  console.log('确定性沉默');

  await ok('收尾话都认得（晚安/睡了/拜拜/上课/吃饭/出门）', () => {
    for (const t of ['晚安', '晚安啦', '睡了', '我去睡了', '先睡了', '困了', '拜拜', '再见', '88', '我走了', '去上课了', '我出门了', '吃饭去了', '洗澡去了', '先这样', '回头聊']) {
      assert.ok(isClosing(t), t);
    }
  });

  await ok('日常话不算收尾', () => {
    for (const t of ['在吗', '你好', '今天过得怎么样', '晚安吗', '我不想睡觉', '再见鬼', '我去上课的路上看到一只猫']) {
      assert.ok(!isClosing(t), t);
    }
  });

  await ok('收尾话分类型（night / eat / busy / bye）', () => {
    assert.strictEqual(kindOf('晚安'), 'night');
    assert.strictEqual(kindOf('我困了'), 'night');
    assert.strictEqual(kindOf('吃饭去了'), 'eat');
    assert.strictEqual(kindOf('去上课了'), 'busy');
    assert.strictEqual(kindOf('拜拜'), 'bye');
  });

  await ok('第一次晚安会回一句很短的话', () => {
    const r = closingReply('晚安', { rng: () => 0, lastReplyAt: 0, now: 1000000 });
    assert.ok(r.text, '应该有回复');
    assert.ok(r.text.length <= 10, '要短：' + r.text);
    assert.strictEqual(r.quietMs, QUIET_AFTER_BYE_MS);
  });

  await ok('刚道过别（5 分钟内）就真的不回', () => {
    const now = 1000000;
    const r = closingReply('晚安', { rng: () => 0.5, lastReplyAt: now - 60000, now });
    assert.strictEqual(r.text, '');
    assert.ok(r.quietMs > 0);
  });

  await ok('超过 5 分钟又回一句', () => {
    const now = 1000000;
    const r = closingReply('晚安', { rng: () => 0, lastReplyAt: now - QUIET_AFTER_BYE_MS - 1000, now });
    assert.ok(r.text);
  });

  console.log('情绪有原因');

  await ok('被夸 → content + 原因', () => {
    const st = createSelfState({ file: tmp('s1'), log: silent });
    st.react({ text: '你今天好可爱啊' });
    const s = st.get();
    assert.strictEqual(s.mood, 'content');
    assert.ok(s.cause.includes('夸'), s.cause);
    assert.ok(st.describe().includes('原因'), st.describe());
  });

  await ok('诉苦 → calm + 让他轻点说话', () => {
    const st = createSelfState({ file: tmp('s2'), log: silent });
    st.react({ text: '今天好烦啊，压力好大' });
    const s = st.get();
    assert.strictEqual(s.mood, 'calm');
    assert.ok(s.cause.includes('心情不好'), s.cause);
  });

  await ok('被骂 → annoyed', () => {
    const st = createSelfState({ file: tmp('s3'), log: silent });
    st.react({ text: '你个笨蛋' });
    assert.strictEqual(st.get().mood, 'annoyed');
    assert.ok(st.get().cause.includes('不好听'));
  });

  await ok('闹着玩 → good', () => {
    const st = createSelfState({ file: tmp('s4'), log: silent });
    st.react({ text: '哈哈哈哈哈笑死' });
    assert.strictEqual(st.get().mood, 'good');
  });

  await ok('说想你 → lonely', () => {
    const st = createSelfState({ file: tmp('s5'), log: silent });
    st.react({ text: '我想你了' });
    assert.strictEqual(st.get().mood, 'lonely');
  });

  await ok('群聊里不改情绪', () => {
    const st = createSelfState({ file: tmp('s6'), log: silent });
    st.react({ text: '你好可爱', isGroup: true });
    assert.strictEqual(st.get().cause || '', '');
  });

  await ok('普通聊天不改情绪', () => {
    const st = createSelfState({ file: tmp('s7'), log: silent });
    const before = st.get().mood;
    st.react({ text: '今天几号来着' });
    assert.strictEqual(st.get().mood, before);
  });

  await ok('原因超过 2 小时自动失效', () => {
    const st = createSelfState({ file: tmp('s8'), log: silent });
    st.react({ text: '你好可爱' });
    assert.ok(st.describe().includes('原因'));
    st.set({ causeAt: Date.now() - 3 * 3600 * 1000 });
    assert.ok(!st.describe().includes('原因'), st.describe());
  });

  await ok('有原因时 bump(owner) 不把心情冲掉', () => {
    const st = createSelfState({ file: tmp('s9'), log: silent });
    st.react({ text: '你好可爱' });
    st.bump('owner');
    assert.strictEqual(st.get().mood, 'content');
  });

  console.log('纪念日');

  await ok('认识第 100 天会主动提一次', () => {
    const f = tmp('i1');
    const now = Date.UTC(2026, 10, 13, 2, 0, 0);
    const life = createInnerLife({ file: f, cfg: {}, log: silent, now: () => now });
    const since = now - 99 * 86400000;
    const ctx = life.contextFor({ scene: 'c2c', owner: true, since });
    assert.ok(ctx.includes('今天是个日子'), ctx);
    assert.ok(ctx.includes('第 100 天'), ctx);
  });

  await ok('同一天不会重复提', () => {
    const f = tmp('i2');
    const now = Date.UTC(2026, 10, 13, 2, 0, 0);
    const life = createInnerLife({ file: f, cfg: {}, log: silent, now: () => now });
    const since = now - 99 * 86400000;
    life.contextFor({ scene: 'c2c', owner: true, since });
    const second = life.contextFor({ scene: 'c2c', owner: true, since });
    assert.ok(!second.includes('今天是个日子'), second);
  });

  await ok('普通日子不煽情', () => {
    const f = tmp('i3');
    const now = Date.UTC(2026, 10, 13, 2, 0, 0);
    const life = createInnerLife({ file: f, cfg: {}, log: silent, now: () => now });
    const since = now - 42 * 86400000;
    const ctx = life.contextFor({ scene: 'c2c', owner: true, since });
    assert.ok(!ctx.includes('今天是个日子'), ctx);
  });

  await ok('周年（365 天）特别说法', () => {
    const f = tmp('i4');
    const now = Date.UTC(2026, 10, 13, 2, 0, 0);
    const life = createInnerLife({ file: f, cfg: {}, log: silent, now: () => now });
    const since = now - 364 * 86400000;
    const a = life.anniversaryFor({ since });
    assert.ok(a && a.days === 365, JSON.stringify(a));
    assert.ok(a.text.includes('一整年'), a.text);
  });

  await ok('没给 since（不知道认识多久）就不提', () => {
    const f = tmp('i5');
    const life = createInnerLife({ file: f, cfg: {}, log: silent, now: () => Date.UTC(2026, 10, 13, 2, 0, 0) });
    assert.strictEqual(life.anniversaryFor({ since: 0 }), null);
    assert.ok(!life.contextFor({ scene: 'c2c', owner: true, since: 0 }).includes('今天是个日子'));
  });

  await ok('dayMood 24 小时内有效（日记用）', () => {
    const f = tmp('m1');
    const state = createSelfState({ file: f, log: silent });
    state.react({ text: '我今天好累啊' });
    assert.ok(state.dayMood({ hours: 24 }).includes('他心情不好'), state.dayMood({ hours: 24 }));
    assert.ok(state.lastCause({ hours: 24 }));
  });

  await ok('dayMood 超过 24 小时就不写了', () => {
    const f = tmp('m2');
    const state = createSelfState({ file: f, log: silent });
    state.react({ text: '你真好' });
    state.set({ causeAt: Date.now() - 25 * 3600 * 1000 });
    assert.strictEqual(state.dayMood({ hours: 24 }), '');
    assert.ok(state.describe().includes('原因') === false);
  });

  await ok('日记会把心情当素材喂进去（不编）', async () => {
    const { Brain } = require('../src/brain');
    const { loadConfig } = require('../src/config');
    const cfg = loadConfig();
    const brain = new Brain(cfg, { log: silent });
    let captured = null;
    brain._complete = async (messages) => {
      captured = messages;
      return '今天很安静。';
    };
    const out = await brain.writeDiary({ dateText: '11月13日', convo: ['他：累了'], mood: '心里软软的，他刚夸你' });
    assert.strictEqual(out, '今天很安静。');
    const user = captured.find((m) => m.role === 'user').content;
    assert.ok(user.includes('你今天大概是什么状态'), user);
    assert.ok(user.includes('心里软软的'), user);
  });

  console.log(`\n通过 ${pass}  失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
