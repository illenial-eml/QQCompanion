'use strict';
/**
 * 「有人找你」通知：别人点名找主人 / 她觉得答不上来 → 私信提醒主人上号。
 */
const assert = require('assert');
const {
  looksForOwner,
  looksStuck,
  createNotifier,
  NOTIFY_DEFAULTS,
} = require('../src/notify-owner');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\n=== 有人找你 ===\n');

ok('别人明确点名找主人', () => {
  assert.ok(looksForOwner('我找火鸟'));
  assert.ok(looksForOwner('你们主人在吗'));
  assert.ok(looksForOwner('叫本人来'));
  assert.ok(looksForOwner('帮我转告你主人'));
  assert.ok(looksForOwner('火鸟呢'));
});

ok('问「你是机器人吗」也算找人', () => {
  assert.ok(looksForOwner('你是机器人吧'));
  assert.ok(looksForOwner('你是AI吗'));
});

ok('普通闲聊不误判', () => {
  assert.strictEqual(looksForOwner('今天天气不错'), null);
  assert.strictEqual(looksForOwner('我主人是谁'), null);
  assert.strictEqual(looksForOwner(''), null);
  assert.strictEqual(looksForOwner('哈哈哈哈'), null);
});

ok('主人自己在说话时不触发（由调用方判断 fromOwner）', () => {
  // 这个函数本身只看文本，是否调用由 responder 的 fromOwner 控制
  assert.ok(typeof looksForOwner === 'function');
});

ok('她 PASS（没话说）= 答不上来', () => {
  assert.strictEqual(looksStuck(''), 'pass');
  assert.strictEqual(looksStuck('   '), 'pass');
});

ok('她回「不知道」这类也算答不上来', () => {
  assert.strictEqual(looksStuck('不知道诶'), 'dont-know');
  assert.strictEqual(looksStuck('嗯…这个我说不好'), 'dont-know');
  assert.strictEqual(looksStuck('我也不会'), 'dont-know');
});

ok('她冒出自我定位的话也要提醒', () => {
  assert.strictEqual(looksStuck('我本来就是个对象'), 'self-position');
});

ok('正常回话不触发', () => {
  assert.strictEqual(looksStuck('好啊，我下午去'), null);
  assert.strictEqual(looksStuck('这个我知道，是生物题'), null);
});

ok('穿帮了（跑出一整段英文/开发术语）也要提醒', () => {
  // 2026-10-28 真实发生过的一次：别人发「325325325」，她回了这一段
  assert.strictEqual(
    looksStuck('This entity is not registered in `data/entities/k666.json`. Ask your maintainers if this is intentional.'),
    'english-leak'
  );
  assert.strictEqual(looksStuck('is not registered in the entity list'), 'dev-leak');
  assert.strictEqual(looksStuck('ask your maintainers please'), 'dev-leak');
});

ok('短英文/夹中文的正常回复不算穿帮', () => {
  assert.strictEqual(looksStuck('ok'), null);
  assert.strictEqual(looksStuck('lol 这也行'), null);
  assert.strictEqual(looksStuck('不知道诶'), 'dont-know');
});

// ---------- 防刷 ----------
function mkNotifier(nowRef, cfg = {}) {
  const called = [];
  const n = createNotifier({
    cfg: { ...NOTIFY_DEFAULTS, ...cfg },
    now: () => nowRef.t,
    onNotify: async (x) => called.push(x),
  });
  return { n, called };
}

ok('同一对象冷却期内只提醒一次', async () => {
  const nowRef = { t: 1_000_000 };
  const { n, called } = mkNotifier(nowRef, { cooldownMinutes: 30, minIntervalMinutes: 0 });
  assert.strictEqual(await n.maybe({ kind: 'find', reason: 'a', window: 'u1', who: 'u1' }), true);
  assert.strictEqual(await n.maybe({ kind: 'find', reason: 'b', window: 'u1', who: 'u1' }), false);
  nowRef.t += 31 * 60000;
  assert.strictEqual(await n.maybe({ kind: 'find', reason: 'c', window: 'u1', who: 'u1' }), true);
  assert.strictEqual(called.length, 2);
});

ok('全局最小间隔会拦掉连发', async () => {
  const nowRef = { t: 1_000_000 };
  const { n } = mkNotifier(nowRef, { cooldownMinutes: 0, minIntervalMinutes: 10 });
  assert.strictEqual(await n.maybe({ kind: 'find', reason: 'a', window: 'u1', who: 'u1' }), true);
  nowRef.t += 60000;
  assert.strictEqual(await n.maybe({ kind: 'find', reason: 'b', window: 'u2', who: 'u2' }), false);
  nowRef.t += 10 * 60000;
  assert.strictEqual(await n.maybe({ kind: 'find', reason: 'c', window: 'u2', who: 'u2' }), true);
});

ok('关掉开关就完全不提醒', async () => {
  const nowRef = { t: 1_000_000 };
  const { n, called } = mkNotifier(nowRef, { enabled: false });
  assert.strictEqual(await n.maybe({ kind: 'find', reason: 'a', window: 'u1', who: 'u1' }), false);
  assert.strictEqual(called.length, 0);
});

ok('通知内容带原话', async () => {
  const nowRef = { t: 1_000_000 };
  const { n, called } = mkNotifier(nowRef, { cooldownMinutes: 0, minIntervalMinutes: 0 });
  await n.maybe({ kind: 'find', reason: 'mantis34：我找火鸟', window: 'u9', who: 'u9' });
  assert.ok(called[0].reason.includes('我找火鸟'));
  assert.strictEqual(called[0].kind, 'find');
});

console.log(`\n通过 ${passed} 项\n`);
