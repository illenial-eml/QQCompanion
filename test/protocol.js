'use strict';
/**
 * 协议层单元自测（不联网）：stub 掉 fetch，验证
 *  - token 请求/响应/错误码
 *  - 鉴权头格式
 *  - 网关取址 -> WS 事件解析 -> 归一化消息
 *  - 发送单聊消息的 body 字段
 *  - 去重
 */
const assert = require('assert');
const { QQBotClient } = require('../src/qq');
const { splitReply } = require('../src/responder');

const calls = [];
function stubFetch(handler) {
  global.fetch = async (url, opts) => {
    const c = { url: String(url), method: opts?.method || 'GET', headers: opts?.headers || {}, body: opts?.body };
    calls.push(c);
    const r = handler(c);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
}

const cfg = {
  qq: { appId: '102012345', clientSecret: 'SECRET', allowFrom: [], replyInGroup: true, maxReplyChars: 1500 },
  brain: {},
};
const log = { debug() {}, info() {}, warn() {}, error() {} };

(async () => {
  // ---------- 1. token ----------
  stubFetch((c) => {
    assert.ok(c.url.endsWith('/app/getAppAccessToken'), 'token URL: ' + c.url);
    assert.strictEqual(c.body, JSON.stringify({ appId: '102012345', clientSecret: 'SECRET' }));
    return { status: 200, body: { access_token: 'TOKEN_ABC', expires_in: '7200' } };
  });

  const bot = new QQBotClient(cfg, { log });
  const tok = await bot._getToken();
  assert.strictEqual(tok, 'TOKEN_ABC');
  assert.ok(bot.tokenExpireAt > Date.now() + 60000 * 100, '过期时间应提前刷新');
  console.log('✓ token 获取（字符串 expires_in 兼容）');

  // 有效期内复用，不再请求
  const before = calls.length;
  await bot._getToken();
  assert.strictEqual(calls.length, before, '有效期内不应重复请求');
  console.log('✓ token 缓存');

  // ---------- 2. 业务接口鉴权头 + 发送 body ----------
  stubFetch((c) => {
    assert.strictEqual(c.headers.Authorization, 'QQBot TOKEN_ABC', '鉴权头必须是 QQBot 前缀');
    return { status: 200, body: { id: 'ROBOT1.0_x', timestamp: 't' } };
  });
  await bot.sendC2C('OPENID_1', '你好', { msgId: 'MSG_1', msgSeq: 1 });
  const sendCall = calls[calls.length - 1];
  assert.ok(sendCall.url.endsWith('/v2/users/OPENID_1/messages'), sendCall.url);
  assert.deepStrictEqual(JSON.parse(sendCall.body), {
    content: '你好', msg_type: 0, msg_seq: 1, msg_id: 'MSG_1',
  });
  console.log('✓ 单聊被动回复 body 正确');

  await bot.sendC2C('OPENID_1', '主动', { msgSeq: 2 });
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].body), {
    content: '主动', msg_type: 0, msg_seq: 2,
  });
  console.log('✓ 主动消息不带 msg_id');

  await bot.sendGroup('GROUP_1', '群', { msgId: 'MSG_2', msgSeq: 1 });
  assert.ok(calls[calls.length - 1].url.endsWith('/v2/groups/GROUP_1/messages'));
  console.log('✓ 群聊接口');

  // ---------- 3. token 失效自动重试 ----------
  let firstApi = true;
  stubFetch((c) => {
    if (c.url.endsWith('/app/getAppAccessToken')) {
      return { status: 200, body: { access_token: 'TOKEN_NEW', expires_in: '7200' } };
    }
    if (firstApi) { firstApi = false; return { status: 401, body: { err_code: 11244, message: 'token expired' } }; }
    return { status: 200, body: { id: 'ok' } };
  });
  bot.token = 'TOKEN_OLD'; bot.tokenExpireAt = Date.now() + 9999999;
  const r2 = await bot.sendC2C('O', 'x', { msgId: 'M' });
  assert.strictEqual(r2.id, 'ok');
  assert.strictEqual(bot.token, 'TOKEN_NEW');
  console.log('✓ 401 后自动刷新 token 并重试');

  // ---------- 4. 事件解析 ----------
  const events = [];
  bot.on('message', (m) => events.push(m));
  bot._dispatch('C2C_MESSAGE_CREATE', {
    id: 'ROBOT1.0_MSG',
    content: '  在吗  ',
    author: { user_openid: 'OPENID_1', username: '小明' },
    timestamp: '2026-10-25T10:00:00+08:00',
    message_type: 0,
    attachments: [],
  });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].scene, 'c2c');
  assert.strictEqual(events[0].userId, 'OPENID_1');
  assert.strictEqual(events[0].content, '在吗');
  console.log('✓ C2C_MESSAGE_CREATE 解析 + 去空白');

  // 重复推送去重
  bot._dispatch('C2C_MESSAGE_CREATE', { id: 'ROBOT1.0_MSG', content: 'dup', author: { user_openid: 'X' } });
  assert.strictEqual(events.length, 1, '重复 msg_id 应被丢弃');
  console.log('✓ 重复 msg_id 去重');

  // 语音消息用 ASR 兜底
  bot._dispatch('C2C_MESSAGE_CREATE', {
    id: 'ROBOT1.0_VOICE', content: '',
    author: { user_openid: 'OPENID_1' },
    attachments: [{ content_type: 'voice', asr_refer_text: '我说的是语音' }],
  });
  assert.strictEqual(events[events.length - 1].content, '我说的是语音');
  console.log('✓ 语音消息 ASR 兜底');

  // 群消息
  bot._dispatch('GROUP_AT_MESSAGE_CREATE', {
    id: 'ROBOT1.0_G', content: '群里问一句',
    author: { member_openid: 'MEMBER_1', username: '小明' },
    group_openid: 'GROUP_1',
  });
  const g = events[events.length - 1];
  assert.strictEqual(g.scene, 'group');
  assert.strictEqual(g.groupId, 'GROUP_1');
  assert.strictEqual(g.userId, 'MEMBER_1');
  console.log('✓ GROUP_AT_MESSAGE_CREATE 解析');

  // ---------- 5. 长回复分段 ----------
  const long = Array.from({ length: 80 }, (_, i) => `第${i + 1}句话，说点什么呢。`).join('');
  const chunks = splitReply(long, 100);
  assert.ok(chunks.every((c) => c.length <= 100), '每段不应超过上限: ' + chunks.map((c) => c.length));
  assert.strictEqual(chunks.join(''), long.replace(/\s/g, ''), '拼回来应与原文一致');
  assert.ok(chunks.length >= 6, '应该切成多段，实际 ' + chunks.length);
  assert.ok(chunks.slice(0, -1).every((c) => /[。！？，]$/.test(c)), '除了最后一段，都该在标点处断开');
  console.log(`✓ 长回复分段（${long.length} 字 -> ${chunks.length} 段，每段 <= 100，按标点断开）`);

  const shortChunks = splitReply('短消息', 1500);
  assert.deepStrictEqual(shortChunks, ['短消息']);
  console.log('✓ 短消息不分段');

  console.log('\n全部协议层测试通过 ✅');
})().catch((e) => { console.error('❌ 测试失败:', e.message); console.error(e); process.exit(1); });
