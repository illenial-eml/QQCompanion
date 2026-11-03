'use strict';
// 引用回复开关测试：私聊默认不带 reply 段，群里带，'none' 全不带，'all' 私聊也带
const assert = require('assert');
const path = require('path');

const { OneBotClient } = require(path.join(__dirname, '..', 'src', 'onebot.js'));

function makeClient(quoteReply) {
  const sent = [];
  const c = new OneBotClient(
    { onebot: quoteReply === undefined ? {} : { quoteReply } },
    { log: { info() {}, warn() {}, debug() {}, error() {} } }
  );
  c.api = async (action, params) => {
    sent.push({ action, params });
    return { ok: true };
  };
  return { c, sent };
}

const checks = [];
const run = (name, fn) => {
  try {
    fn();
    checks.push([name, true]);
    console.log('✓', name);
  } catch (e) {
    checks.push([name, false]);
    console.log('✗', name, '→', e.message);
  }
};
const types = (m) => m.map((s) => s.type);

(async () => {
  let r = makeClient('group');
  await r.c.sendC2C(123, '你好', { msgId: 99 });
  run('私聊默认不带 reply', () => assert.deepStrictEqual(types(r.sent[0].params.message), ['text']));

  r = makeClient('group');
  await r.c.sendGroup(456, '群里', { msgId: 99 });
  run('群里默认带 reply', () => assert.deepStrictEqual(types(r.sent[0].params.message), ['reply', 'text']));

  r = makeClient('none');
  await r.c.sendGroup(456, '群里', { msgId: 99 });
  await r.c.sendC2C(123, '私聊', { msgId: 99 });
  run("'none' 两边都不带", () => {
    assert.deepStrictEqual(types(r.sent[0].params.message), ['text']);
    assert.deepStrictEqual(types(r.sent[1].params.message), ['text']);
  });

  r = makeClient('all');
  await r.c.sendC2C(123, '私聊', { msgId: 99 });
  run("'all' 私聊也带", () => assert.deepStrictEqual(types(r.sent[0].params.message), ['reply', 'text']));

  r = makeClient(undefined);
  await r.c.sendC2C(123, '默认值', { msgId: 99 });
  run('未配置时私聊不带（默认 group）', () => assert.deepStrictEqual(types(r.sent[0].params.message), ['text']));

  r = makeClient('group');
  await r.c.sendC2C(123, '无引用源', {});
  run('没有 msgId 时不带 reply', () => assert.deepStrictEqual(types(r.sent[0].params.message), ['text']));

  const bad = checks.filter(([, ok]) => !ok).length;
  console.log(bad === 0 ? '\n引用回复开关测试全部通过 ✅' : `\n${bad} 项失败 ❌`);
  process.exit(bad === 0 ? 0 : 1);
})();
