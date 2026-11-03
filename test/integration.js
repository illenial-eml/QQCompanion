'use strict';
/**
 * 端到端「模拟 QQ」集成测试：不需要真 AppID/AppSecret，也不需要腾讯服务器。
 *
 * 做法：把全局 fetch 和 WebSocket 换成假的——
 *   - 假 token 接口 / 假网关 / 假发消息接口（记录请求体）
 *   - 假 WebSocket：收到 Identify 后回 READY，之后可主动推送消息事件
 * 这样能验证真正的装配链路：
 *   QQBotClient -> 事件归一化 -> responder -> 分条发送 -> REST 请求体
 *
 * 用法： node test/integration.js
 */
const assert = require('node:assert');

const SENT = [];        // 记录所有 REST 请求
let accessTokenCalls = 0;

const jsonRes = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(obj),
});

// ---- 假 fetch ----
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();

  if (u.includes('/app/getAppAccessToken')) {
    accessTokenCalls += 1;
    return jsonRes({ access_token: 'FAKE_TOKEN', expires_in: '7200' });
  }
  if (u.endsWith('/gateway')) {
    return jsonRes({ url: 'wss://api.bot.qq.com/websocket/' });
  }
  if (u.includes('/messages')) {
    SENT.push({ url: u, method, body: JSON.parse(opts.body || '{}') });
    return jsonRes({ id: 'ROBOT1.0_fake', timestamp: new Date().toISOString() });
  }
  throw new Error('未预期的请求: ' + u);
};

// ---- 假 WebSocket ----
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.handlers = {};
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this._fire('open', {});
      this._recv({ op: 10, d: { heartbeat_interval: 45000 } });
    }, 0);
  }

  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }

  _fire(type, ev) { for (const fn of this.handlers[type] || []) fn(ev); }

  _recv(obj) { this._fire('message', { data: JSON.stringify(obj) }); }

  send(raw) {
    this.sent.push(raw);
    const p = JSON.parse(raw);
    if (p.op === 2) {
      // Identify -> READY
      setTimeout(() => this._recv({
        op: 0, s: 1, t: 'READY',
        d: { version: 1, session_id: 'SESSION-1', user: { id: '90000', username: '小D' }, shard: [0, 1] },
      }), 0);
    }
  }

  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeWebSocket;

const path = require('node:path');
const { loadConfig } = require(path.join(__dirname, '..', 'src', 'config'));
const { createLogger } = require(path.join(__dirname, '..', 'src', 'log'));
const { QQBotClient } = require(path.join(__dirname, '..', 'src', 'qq'));
const { createResponder } = require(path.join(__dirname, '..', 'src', 'responder'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = { info() {}, warn() {}, error() {}, debug() {} };

function makeCfg(over = {}) {
  const cfg = loadConfig();
  if (cfg.qq) cfg.qq.naturalLines = false; // 集成测试关心「不丢字」，关掉自然分行改写
  cfg.qq.appId = '123456789';
  cfg.qq.clientSecret = 'fake-secret';
  cfg.qq.allowFrom = [];
  cfg.qq.replyInGroup = true;
  cfg.qq.maxReplyChars = 100;
  cfg.rhythm = { enabled: false };   // 节奏有自己的单测，这里只管协议链路
  return Object.assign(cfg, over);
}

function c2cEvent(id, content, openid = 'OPENID_A') {
  return {
    op: 0, s: 2, t: 'C2C_MESSAGE_CREATE',
    d: {
      id,
      author: { id: openid, user_openid: openid, username: '小明' },
      content,
      message_type: 0,
      timestamp: '2026-10-25T02:00:00+08:00',
      message_scene: { source: 'default', ext: [] },
    },
  };
}

(async () => {
  const cfg = makeCfg();
  const bot = new QQBotClient(cfg, { log: silent });

  let replyText = '在呢，怎么了？';
  const fakeBrain = { chat: async () => replyText };
  const responder = createResponder({ cfg, bot, brain: fakeBrain, log: silent });

  // main.js 里的那条链路：bot 收到消息 -> responder.handle
  const handled = [];
  bot.on('message', (msg) => { handled.push(responder.handle(msg)); });
  /** 等最近一次消息处理真正结束（回复可能分好几条，耗时更长） */
  const waitLast = async () => { const p = handled[handled.length - 1]; if (p) await p; };

  let ready = false;
  bot.on('ready', () => { ready = true; });

  await bot.connect();
  for (let i = 0; i < 50 && !ready; i++) await sleep(10);
  assert.equal(ready, true, '应该收到 READY');
  console.log('✓ 假网关完成握手：token -> gateway -> identify -> READY');
  assert.equal(accessTokenCalls, 1, 'token 只应该取一次');
  assert.ok(bot.sessionId === 'SESSION-1');

  // ---- 1. 普通单聊消息 ----
  FakeWebSocket.last._recv(c2cEvent('MSG_1', '  你好呀  '));
  await sleep(60);
  assert.equal(SENT.length, 1, `应该回 1 条，实际 ${SENT.length}`);
  assert.match(SENT[0].url, /\/v2\/users\/OPENID_A\/messages$/);
  assert.equal(SENT[0].body.msg_id, 'MSG_1', '被动回复必须带 msg_id');
  assert.equal(SENT[0].body.msg_seq, 1);
  assert.equal(SENT[0].body.msg_type, 0);
  assert.equal(SENT[0].body.content, '在呢，怎么了？');
  console.log('✓ 收到单聊消息 -> 调模型 -> 被动回复（带 msg_id）:', SENT[0].body.content);

  // ---- 2. 同一条消息重复推送（腾讯会重复推）----
  FakeWebSocket.last._recv(c2cEvent('MSG_1', '  你好呀  '));
  await sleep(60);
  assert.equal(SENT.length, 1, '重复的 msg_id 不应该再回一次');
  console.log('✓ 重复推送被去重');

  // ---- 3. 长回复：分条 + 前 4 条被动、之后主动 ----
  SENT.length = 0;
  replyText = Array.from({ length: 60 }, (_, i) => `第${i + 1}句，随便说点什么。`).join('');
  FakeWebSocket.last._recv(c2cEvent('MSG_2', '你多说点'));
  await waitLast();
  assert.ok(SENT.length >= 2, `长回复应该分条，实际 ${SENT.length} 条`);
  for (const s of SENT) assert.ok(s.body.content.length <= 100, '每段不超过上限');
  const passive = SENT.filter((s) => s.body.msg_id);
  const active = SENT.filter((s) => !s.body.msg_id);
  assert.equal(passive.length, 4, '单聊被动回复最多 4 条');
  assert.equal(passive.map((s) => s.body.msg_seq).join(','), '1,2,3,4', 'msg_seq 递增');
  assert.ok(active.length > 0, '超出部分应该走主动消息');
  assert.equal(SENT.map((s) => s.body.content).join('').length, replyText.length, '分段不丢字');
  console.log(`✓ 长回复分 ${SENT.length} 条：被动 ${passive.length} 条（msg_seq 1-4）+ 主动 ${active.length} 条`);

  // ---- 4. 空内容 / 只有附件 ----
  SENT.length = 0;
  replyText = '不该被调用';
  const ev = c2cEvent('MSG_3', '');
  ev.d.attachments = [{ content_type: 'image/png', url: 'https://example.com/x.png' }];
  FakeWebSocket.last._recv(ev);
  await sleep(60);
  assert.equal(SENT.length, 1, '图片消息应该给一句兜底提示');
  assert.match(SENT[0].body.content, /看不了/);
  console.log('✓ 图片消息走兜底提示，没打扰模型');

  // ---- 5. 群 @ 消息 ----
  SENT.length = 0;
  replyText = '群里也听得见。';
  FakeWebSocket.last._recv({
    op: 0, s: 3, t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'MSG_4',
      author: { id: 'MEMBER_X', member_openid: 'MEMBER_X', username: '小明' },
      content: ' 群里叫你一声 ',
      group_openid: 'GROUP_1',
      timestamp: '2026-10-25T02:01:00+08:00',
    },
  });
  await sleep(60);
  assert.equal(SENT.length, 1);
  assert.match(SENT[0].url, /\/v2\/groups\/GROUP_1\/messages$/);
  assert.equal(SENT[0].body.msg_id, 'MSG_4');
  assert.equal(SENT[0].body.content, '群里也听得见。');
  console.log('✓ 群 @ 消息走 /v2/groups/{group_openid}/messages');

  // ---- 6. 白名单拦截 ----
  SENT.length = 0;
  const cfg2 = makeCfg();
  cfg2.qq.allowFrom = ['OPENID_B'];
  const bot2 = new QQBotClient(cfg2, { log: silent });
  const r2 = createResponder({ cfg: cfg2, bot: bot2, brain: fakeBrain, log: silent });
  const res = await r2.handle({
    scene: 'c2c', msgId: 'MSG_9', userId: 'OPENID_A', userName: '小明', content: '你好',
  });
  assert.equal(res.skipped, 'not-allowed');
  assert.equal(SENT.length, 0);
  console.log('✓ 白名单外的人一条都不发');

  await Promise.all(handled);
  bot.close();
  await sleep(20);
  console.log('\n集成测试全部通过 ✅（真协议链路 + 假服务器）');
  process.exit(0);
})().catch((e) => { console.error('✗ 集成测试失败:', e); process.exit(1); });
