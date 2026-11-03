'use strict';
/**
 * OneBot（小号版）单测：不连真 NapCat，用假 ws 和假事件验证
 * 1) 消息段归一化  2) 事件 → 我们的 msg 形状  3) 发送 action 的 body
 * 4) action 回包路由  5) 戳一戳 / 贴表情
 */
const assert = require('node:assert');
const path = require('path');
const { OneBotClient, normalizeSegments } = require('../src/onebot');

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (e) {
    console.error('  ✗', name, '->', e.message);
    process.exitCode = 1;
  }
}
// 要 await 的用例先攒起来，最后串行跑（CommonJS 里不能用顶层 await）
const asyncTests = [];
function okAsync(name, fn) {
  asyncTests.push([name, fn]);
}
async function runAsyncTests() {
  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      console.log('  ✓', name);
      passed++;
    } catch (e) {
      console.error('  ✗', name, '->', e.message);
      process.exitCode = 1;
    }
  }
}

const log = { info() {}, warn() {}, error() {}, debug() {} };

/** 假 ws：只实现我们用到的那几个字段/方法 */
function fakeWs() {
  const sent = [];
  return {
    sent,
    readyState: 1,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    close() {},
  };
}

function makeClient() {
  const c = new OneBotClient({ onebot: { url: 'ws://127.0.0.1:3001', selfId: 2222 } }, { log });
  c.ws = fakeWs();
  c.selfId = '2222';
  c.ready = true;
  return c;
}

console.log('OneBot（小号版）：');

// 1) 消息段归一化
ok('消息段里文字 / at / 图片 / 表情 / 引用都能拆出来', () => {
  const segs = [
    { type: 'reply', data: { id: '900' } },
    { type: 'at', data: { qq: '2222', name: '水鸡' } },
    { type: 'text', data: { text: ' 你在干嘛' } },
    { type: 'image', data: { url: 'https://x/1.jpg', file: '1.jpg' } },
    { type: 'face', data: { id: '178' } },
  ];
  const r = normalizeSegments(segs, 2222);
  assert.equal(r.replyId, '900');
  assert.ok(r.text.includes('@水鸡'), r.text);
  assert.ok(r.text.includes('你在干嘛'));
  assert.ok(r.text.includes('[表情]'));
  assert.deepEqual(r.atList, ['2222']);
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0].url, 'https://x/1.jpg');
});

// 2) @全体
ok('@全体成员 能被认出来', () => {
  const r = normalizeSegments([{ type: 'at', data: { qq: 'all' } }], 2222);
  assert.ok(r.text.includes('@全体成员'));
  assert.deepEqual(r.atList, ['all']);
});

// 3) 私聊消息归一化
ok('私聊消息 → {scene:c2c, userId, content}', () => {
  const c = makeClient();
  const got = [];
  c.on('message', (m) => got.push(m));
  c._onEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 2222,
    user_id: 777,
    message_id: 1001,
    time: 1700000000,
    sender: { user_id: 777, nickname: '小明' },
    message: [{ type: 'text', data: { text: '在吗' } }],
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].scene, 'c2c');
  assert.equal(got[0].userId, '777');
  assert.equal(got[0].userName, '小明');
  assert.equal(got[0].content, '在吗');
  assert.equal(got[0].mentioned, true, '私聊一律算被叫到');
  assert.equal(got[0].msgId, '1001');
});

// 4) 群消息：@ 了才算 mentioned
ok('群消息 @ 自己 → mentioned=true；没 @ → false', () => {
  const c = makeClient();
  const got = [];
  c.on('message', (m) => got.push(m));
  c._onEvent({
    post_type: 'message', message_type: 'group', self_id: 2222, group_id: 555,
    user_id: 888, message_id: 2001, time: 1700000001,
    sender: { user_id: 888, nickname: '小明', card: '小明群名片' },
    message: [{ type: 'at', data: { qq: '2222' } }, { type: 'text', data: { text: ' 说句话' } }],
  });
  c._onEvent({
    post_type: 'message', message_type: 'group', self_id: 2222, group_id: 555,
    user_id: 889, message_id: 2002, time: 1700000002,
    sender: { user_id: 889, nickname: '小红' },
    message: [{ type: 'text', data: { text: '今天好热' } }],
  });
  assert.equal(got.length, 2);
  assert.equal(got[0].scene, 'group');
  assert.equal(got[0].groupId, '555');
  assert.equal(got[0].mentioned, true);
  assert.equal(got[0].userName, '小明群名片', '优先用群名片');
  assert.equal(got[1].mentioned, false);
});

// 5) 自己发的消息不理
ok('自己号发的消息会被忽略', () => {
  const c = makeClient();
  const got = [];
  c.on('message', (m) => got.push(m));
  c._onEvent({
    post_type: 'message', message_type: 'group', self_id: 2222, group_id: 555,
    user_id: 2222, message_id: 3001, sender: { user_id: 2222 }, message: [{ type: 'text', data: { text: '我自己' } }],
  });
  assert.equal(got.length, 0);
});

// 6) 同一条 message_id 只处理一次
ok('重复推送的 message_id 会被去重', () => {
  const c = makeClient();
  const got = [];
  c.on('message', (m) => got.push(m));
  const ev = {
    post_type: 'message', message_type: 'private', self_id: 2222, user_id: 777,
    message_id: 4001, time: 1700000003, sender: { user_id: 777, nickname: 'A' },
    message: [{ type: 'text', data: { text: 'hi' } }],
  };
  c._onEvent(ev);
  c._onEvent(ev);
  assert.equal(got.length, 1);
});

// 7) 戳一戳：目标是自己才理
ok('戳一戳（目标是自己）→ emit poke；目标不是自己就不理', () => {
  const c = makeClient();
  const got = [];
  c.on('poke', (p) => got.push(p));
  c._onEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 2222, user_id: 333, target_id: 2222, group_id: 555, time: 1700000004 });
  c._onEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 2222, user_id: 333, target_id: 999, group_id: 555, time: 1700000005 });
  assert.equal(got.length, 1);
  assert.equal(got[0].scene, 'group');
  assert.equal(got[0].userId, '333');
  assert.equal(got[0].groupId, '555');
});

// 8) api() 发出去的东西 & 回包路由
okAsync('api() 会带 echo 发出去，回包正确 resolve', async () => {
  const c = makeClient();
  const p = c.api('send_private_msg', { user_id: 1, message: [] });
  const sent = c.ws.sent[0];
  assert.equal(sent.action, 'send_private_msg');
  assert.equal(sent.params.user_id, 1);
  assert.ok(sent.echo);
  c._onPayload({ status: 'ok', retcode: 0, data: { message_id: 123 }, echo: sent.echo });
  const r = await p;
  assert.equal(r.message_id, 123);
});

// 9) 协议端报错 → reject（带 retcode）
okAsync('retcode 非 0 时 reject 并带 retcode', async () => {
  const c = makeClient();
  const p = c.api('send_private_msg', {});
  const sent = c.ws.sent[0];
  c._onPayload({ status: 'failed', retcode: 100, message: '风控', echo: sent.echo });
  await assert.rejects(p, (e) => e.retcode === 100 && /风控/.test(e.message));
});

// 10) sendC2C 默认不带引用（用户要求私聊不要 QQ 的「回复」气泡）
okAsync('sendC2C 默认不带 reply 段（只有纯文本）', async () => {
  const c = makeClient();
  const p = c.sendC2C('777', '收到', { msgId: '9001' });
  const sent = c.ws.sent[0];
  assert.equal(sent.action, 'send_private_msg');
  assert.equal(sent.params.user_id, 777);
  assert.deepEqual(sent.params.message, [{ type: 'text', data: { text: '收到' } }]);
  c._onPayload({ status: 'ok', retcode: 0, data: {}, echo: sent.echo });
  await p;
});

// 10b) quoteReply=all 时私聊才带引用
okAsync('quoteReply=all 时 sendC2C 会加 reply 段', async () => {
  const c = new OneBotClient({ onebot: { url: 'ws://127.0.0.1:3001', selfId: 2222, quoteReply: 'all' } }, { log });
  c.ws = fakeWs();
  c.selfId = '2222';
  c.ready = true;
  const p = c.sendC2C('777', '收到', { msgId: '9001' });
  const sent = c.ws.sent[0];
  assert.deepEqual(sent.params.message[0], { type: 'reply', data: { id: '9001' } });
  assert.deepEqual(sent.params.message[1], { type: 'text', data: { text: '收到' } });
  c._onPayload({ status: 'ok', retcode: 0, data: {}, echo: sent.echo });
  await p;
});

// 11) sendGroup
okAsync('sendGroup 走 send_group_msg', async () => {
  const c = makeClient();
  const p = c.sendGroup('555', '群里说话');
  const sent = c.ws.sent[0];
  assert.equal(sent.action, 'send_group_msg');
  assert.equal(sent.params.group_id, 555);
  assert.equal(sent.params.message[0].data.text, '群里说话');
  c._onPayload({ status: 'ok', retcode: 0, data: {}, echo: sent.echo });
  await p;
});

// 12) 真·戳一戳
okAsync('sendNudge → friend_poke / group_poke', async () => {
  const c = makeClient();
  const p1 = c.sendNudge({ scene: 'c2c', userId: '777' });
  assert.equal(c.ws.sent[0].action, 'friend_poke');
  assert.equal(c.ws.sent[0].params.user_id, 777);
  c._onPayload({ status: 'ok', retcode: 0, data: {}, echo: c.ws.sent[0].echo });
  assert.equal((await p1).ok, true);

  const c2 = makeClient();
  const p2 = c2.sendNudge({ scene: 'group', groupId: '555', userId: '777' });
  assert.equal(c2.ws.sent[0].action, 'group_poke');
  assert.equal(c2.ws.sent[0].params.group_id, 555);
  c2._onPayload({ status: 'ok', retcode: 0, data: {}, echo: c2.ws.sent[0].echo });
  assert.equal((await p2).ok, true);
});

// 13) 戳失败时返回 unsupported（和官方版接口约定一致）
okAsync('戳失败时返回 { ok:false, unsupported:true }', async () => {
  const c = makeClient();
  const p = c.sendNudge({ scene: 'c2c', userId: '777' });
  c._onPayload({ status: 'failed', retcode: 1400, message: '不支持', echo: c.ws.sent[0].echo });
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.unsupported, true);
  assert.equal(r.retcode, 1400);
});

// 14) 真·贴表情
okAsync('setMsgEmojiLike → set_msg_emoji_like', async () => {
  const c = makeClient();
  const p = c.setMsgEmojiLike('9001', '128512');
  const sent = c.ws.sent[0];
  assert.equal(sent.action, 'set_msg_emoji_like');
  assert.equal(sent.params.message_id, 9001);
  assert.equal(sent.params.emoji_id, '128512');
  c._onPayload({ status: 'ok', retcode: 0, data: {}, echo: sent.echo });
  assert.equal((await p).ok, true);
});

// 15) 没连上时调用会 reject 而不是卡死
okAsync('没连上时 api() 立刻 reject', async () => {
  const c = new OneBotClient({ onebot: {} }, { log });
  c.ws = null;
  await assert.rejects(c.api('get_login_info'), /还没连上/);
});

// 16) 回归：启动入口能被 require（不跑 main）
ok('onebot-main.js 能正常加载（语法/依赖都 OK）', () => {
  const m = require('../src/onebot-main');
  assert.equal(typeof m.main, 'function');
  assert.equal(typeof m.enqueue, 'function');
  assert.equal(typeof m.createOneBotStickerService, 'function');
});

runAsyncTests().then(() => {
  console.log(`\n通过 ${passed} 项`);
});
void path;
