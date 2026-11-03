'use strict';
// 贴表情：情绪判断 + 概率/冷却/上限 + 调接口（全离线，假 client）
const assert = require('assert');
const { createEmojiLiker, EMOJI_LIKE_DEFAULTS, toneOf, FACE_NAME } = require('../src/emojilike');

let pass = 0;
let fail = 0;
async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail += 1;
    console.log('  ✗ ' + name + ': ' + e.message);
  }
}

function mkClient({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async setMsgEmojiLike(msgId, emojiId, opts) {
      calls.push({ msgId, emojiId, opts });
      if (fail) return { ok: false, message: 'msg not found' };
      return { ok: true, data: { result: true } };
    },
  };
}

(async () => {
  console.log('\n=== 贴表情 ===\n');

  await ok('情绪判断：好笑 / 夸 / 无语 / 生气 / 难过', () => {
    assert.strictEqual(toneOf('哈哈哈哈笑死我了'), 'funny');
    assert.strictEqual(toneOf('你太厉害了'), 'like');
    assert.strictEqual(toneOf('无语，服了'), 'speechless');
    assert.strictEqual(toneOf('滚，烦死'), 'angry');
    assert.strictEqual(toneOf('有点难过'), 'sad');
    assert.strictEqual(toneOf('在吗'), 'neutral');
  });

  await ok('贴成功：调用接口并返回名字', async () => {
    const client = mkClient();
    const liker = createEmojiLiker({ client, cfg: { probability: 1 }, log: null });
    const r = await liker.like('123456', { tone: 'funny', sessionKey: 'u:1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(client.calls.length, 1);
    assert.strictEqual(client.calls[0].msgId, '123456');
    assert.ok(['13', '20', '21', '178', '220'].includes(client.calls[0].emojiId));
    assert.ok(r.name && r.name.length > 0);
  });

  await ok('概率 0：不贴（返回 emoji-skip）', async () => {
    const client = mkClient();
    const liker = createEmojiLiker({ client, cfg: { probability: 0 }, log: null });
    const r = await liker.like('1', { tone: 'funny', sessionKey: 'u:2' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'emoji-skip');
    assert.strictEqual(client.calls.length, 0);
  });

  await ok('冷却：同一个会话短时间内只贴一次', async () => {
    let t = 1000;
    const client = mkClient();
    const liker = createEmojiLiker({ client, cfg: { probability: 1, minGapSec: 90 }, log: null, now: () => t });
    const a = await liker.like('1', { tone: 'funny', sessionKey: 'u:3' });
    assert.strictEqual(a.ok, true);
    const b = await liker.like('2', { tone: 'funny', sessionKey: 'u:3' });
    assert.strictEqual(b.ok, false);
    assert.strictEqual(b.reason, 'emoji-cooldown');
    // 换个人不受影响
    const c = await liker.like('3', { tone: 'like', sessionKey: 'u:4' });
    assert.strictEqual(c.ok, true);
    // 过了冷却又能贴
    t += 91 * 1000;
    const d = await liker.like('4', { tone: 'sad', sessionKey: 'u:3' });
    assert.strictEqual(d.ok, true);
  });

  await ok('每日上限：到顶就不再贴', async () => {
    const client = mkClient();
    const liker = createEmojiLiker({ client, cfg: { probability: 1, minGapSec: 0, maxPerDay: 2 }, log: null });
    assert.strictEqual((await liker.like('1', { sessionKey: 'a' })).ok, true);
    assert.strictEqual((await liker.like('2', { sessionKey: 'b' })).ok, true);
    const r = await liker.like('3', { sessionKey: 'c' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'emoji-day-limit');
  });

  await ok('接口报错：返回失败但不抛', async () => {
    const client = mkClient({ fail: true });
    const liker = createEmojiLiker({ client, cfg: { probability: 1 }, log: null });
    const r = await liker.like('1', { sessionKey: 'x' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason);
  });

  await ok('没有 msgId 直接跳过', async () => {
    const client = mkClient();
    const liker = createEmojiLiker({ client, cfg: { probability: 1 }, log: null });
    const r = await liker.like('', { sessionKey: 'x' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-msgid');
  });

  await ok('关掉开关：一个都不贴', async () => {
    const client = mkClient();
    const liker = createEmojiLiker({ client, cfg: { enabled: false }, log: null });
    const r = await liker.like('1', { sessionKey: 'x', probability: 1 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'emoji-off');
    assert.strictEqual(client.calls.length, 0);
  });

  await ok('表情表可以覆盖（校准用）', async () => {
    const client = mkClient();
    const liker = createEmojiLiker({ client, cfg: { probability: 1, tones: { funny: [178] } }, log: null });
    const r = await liker.like('1', { tone: 'funny', sessionKey: 'y' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(client.calls[0].emojiId, '178');
    assert.strictEqual(r.name, FACE_NAME[178]);
  });

  await ok('force 绕过概率和冷却（给自测用）', async () => {
    let t = 0;
    const client = mkClient();
    const liker = createEmojiLiker({ client, cfg: { probability: 0, minGapSec: 999 }, log: null, now: () => t });
    const r = await liker.like('1', { tone: 'like', sessionKey: 'z', force: true });
    assert.strictEqual(r.ok, true);
    const r2 = await liker.like('2', { tone: 'like', sessionKey: 'z', force: true });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(client.calls.length, 2);
  });

  await ok('默认配置齐全', () => {
    assert.ok(EMOJI_LIKE_DEFAULTS.probability > 0);
    assert.ok(EMOJI_LIKE_DEFAULTS.maxPerDay > 0);
    assert.ok(Object.keys(FACE_NAME).length > 100);
  });

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exitCode = fail ? 1 : 0;
})();
