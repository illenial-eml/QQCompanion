'use strict';
// 代发：主人让鸿去 @人 / 去私聊某人（全离线，只测解析 + 消息段拼装）
const assert = require('assert');
const { parseDirectSay } = require('../src/onebot-main');
const { OneBotClient } = require('../src/onebot');

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

(async () => {
  // ---------- 解析：@ 形式 ----------
  await ok('只 @ 不说话', () => {
    const r = parseDirectSay('@张三');
    assert.strictEqual(r.kind, 'at');
    assert.strictEqual(r.name, '张三');
    assert.strictEqual(r.body, '');
    assert.strictEqual(r.groupHint, '');
  });

  await ok('可以点名指定群（群名 / 群号两种）', () => {
    const a = parseDirectSay('在test群里@张三 说：开会');
    assert.strictEqual(a.kind, 'at');
    assert.strictEqual(a.name, '张三');
    assert.strictEqual(a.body, '开会');
    assert.strictEqual(a.groupHint, 'test');

    const b = parseDirectSay('在群1023192167里@李四 来一下');
    assert.strictEqual(b.name, '李四');
    assert.strictEqual(b.groupHint, '1023192167');

    // 「在群里@…」不算指定群
    assert.strictEqual(parseDirectSay('在群里@张三 说：开会').groupHint, '');
  });

  await ok('@ + 说：正文', () => {
    const r = parseDirectSay('@张三 说：晚上开会');
    assert.strictEqual(r.kind, 'at');
    assert.strictEqual(r.name, '张三');
    assert.strictEqual(r.body, '晚上开会');
  });

  await ok('群里@ + 直接跟正文', () => {
    const r = parseDirectSay('群里@张三 晚上八点开组会');
    assert.strictEqual(r.kind, 'at');
    assert.strictEqual(r.name, '张三');
    assert.strictEqual(r.body, '晚上八点开组会');
  });

  await ok('帮我@一下某人，全角＠也认', () => {
    const r = parseDirectSay('帮我＠一下李四 说 交作业了');
    assert.strictEqual(r.kind, 'at');
    assert.strictEqual(r.name, '李四');
    assert.strictEqual(r.body, '交作业了');
  });

  // ---------- 解析：私聊形式 ----------
  await ok('给X发消息', () => {
    const r = parseDirectSay('给张三发消息：饭吃了吗');
    assert.strictEqual(r.kind, 'c2c');
    assert.strictEqual(r.name, '张三');
    assert.strictEqual(r.body, '饭吃了吗');
  });

  await ok('私聊X', () => {
    const r = parseDirectSay('私聊张三：在吗');
    assert.strictEqual(r.kind, 'c2c');
    assert.strictEqual(r.name, '张三');
    assert.strictEqual(r.body, '在吗');
  });

  await ok('跟X说', () => {
    const r = parseDirectSay('跟王五说：明天交作业');
    assert.strictEqual(r.kind, 'c2c');
    assert.strictEqual(r.name, '王五');
    assert.strictEqual(r.body, '明天交作业');
  });

  // ---------- 不该误判成指令 ----------
  await ok('普通聊天不误判', () => {
    for (const s of ['今天好累', '@', '我说了不算', '你知道吗', '在干嘛呢']) {
      assert.strictEqual(parseDirectSay(s), null, '误判：' + s);
    }
  });

  await ok('代词不当人名', () => {
    assert.strictEqual(parseDirectSay('给我发消息：在吗'), null);
    assert.strictEqual(parseDirectSay('@你 说：你好'), null);
  });

  await ok('只有「跟X说」没正文 → 不当指令', () => {
    assert.strictEqual(parseDirectSay('跟张三说'), null);
  });

  await ok('超长不当指令', () => {
    assert.strictEqual(parseDirectSay('@' + '张'.repeat(400)), null);
  });

  // ---------- 消息段拼装：@ 必须是独立的 at 段 ----------
  function mkClient() {
    const c = Object.create(OneBotClient.prototype);
    c.cfg = {}; // _quoteMode 默认 group
    c.sent = [];
    c.api = async (action, params) => {
      c.sent.push({ action, params });
      return { ok: true };
    };
    return c;
  }

  await ok('sendGroupAt 拼出 at 段 + 文字段', async () => {
    const c = mkClient();
    await c.sendGroupAt('123456', '1000000001', '晚上开会');
    const { action, params } = c.sent[0];
    assert.strictEqual(action, 'send_group_msg');
    assert.strictEqual(params.group_id, 123456);
    const at = params.message.find((s) => s.type === 'at');
    const txt = params.message.find((s) => s.type === 'text');
    assert.ok(at, '缺少 at 段');
    assert.strictEqual(at.data.qq, '1000000001');
    assert.strictEqual(txt.data.text, '晚上开会');
  });

  await ok('只 @ 不留言时没有 text 段', async () => {
    const c = mkClient();
    await c.sendGroupAt('123456', '1000000001', '');
    const segs = c.sent[0].params.message;
    assert.ok(segs.some((s) => s.type === 'at'));
    assert.ok(!segs.some((s) => s.type === 'text'));
  });

  await ok('多人 @ 依次成段', async () => {
    const c = mkClient();
    await c.sendGroupAt('1', ['111111', '222222'], '都来');
    const qs = c.sent[0].params.message.filter((s) => s.type === 'at').map((s) => s.data.qq);
    assert.deepStrictEqual(qs, ['111111', '222222']);
  });

  await ok('非法 QQ 号不会生成 at 段', async () => {
    const c = mkClient();
    await c.sendGroupAt('1', ['abc', ''], '你好');
    assert.ok(!c.sent[0].params.message.some((s) => s.type === 'at'));
  });

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exitCode = fail ? 1 : 0;
})();
