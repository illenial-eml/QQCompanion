'use strict';
/**
 * 转发聊天记录：QQ 把合并转发展开成文本塞在 msg_elements 里（message_type 102/103），
 * content 只是空格占位。这个测试盯三件事：
 *   1. qq.js 能把 msg_elements 里的正文抽出来，并标记 forwarded
 *   2. brain.chat 拿到 forwardText 时，提示词里出现完整正文（不被 240 字截断）
 *   3. responder 收到转发消息会正常调模型，而不是当成「没有文字」直接回「看不了」
 */
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { QQBotClient } = require('../src/qq');
const { Brain } = require('../src/brain');
const { MemoryStore } = require('../src/memory');
const { createResponder } = require('../src/responder');

const log = { info() {}, warn() {}, error() {}, debug() {} };
let passed = 0;
function ok(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('use okAsync');
    console.log('  ✓', name);
    passed++;
  } catch (e) {
    console.error('  ✗', name, '->', e.message);
    process.exitCode = 1;
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
    passed++;
  } catch (e) {
    console.error('  ✗', name, '->', e.message);
    process.exitCode = 1;
  }
}

const FORWARD_BODY = [
  '=== 消息 1 ===',
  '[消息内容] 还在不在',
  '',
  '=== 消息 2 ===',
  '[消息内容] 在呢 刚吃完点东西',
  '',
  '=== 消息 3 ===',
  '[消息内容] 那明天下午三点老地方见？别又迟到',
].join('\n');

function capture(evt) {
  const client = new QQBotClient({ qq: { appId: '1', clientSecret: 'x' } }, { log });
  const got = [];
  client.on(evt, (m) => got.push(m));
  return { client, got };
}

(async () => {
  console.log('转发聊天记录：');

  // 1) 单聊：content 是空格占位，正文在 msg_elements
  {
    const { client, got } = capture('message');
    client._dispatch('C2C_MESSAGE_CREATE', {
      id: 'FWD1',
      author: { user_openid: 'U1' },
      content: ' ',
      message_type: 102,
      msg_elements: [{ content: FORWARD_BODY }],
    });
    ok('单聊转发被识别为 forwarded', () => assert.strictEqual(got[0]?.forwarded, true));
    ok('正文完整抽出来了', () => assert.ok(got[0].forwardText.includes('老地方见')));
    ok('content 也能兜底成正文（不是空串）', () => assert.ok(got[0].content.includes('老地方见')));
  }

  // 2) 群里：message_type 103 也兼容（官方文档两种都出现过）
  {
    const { client, got } = capture('message');
    client._dispatch('GROUP_MESSAGE_CREATE', {
      id: 'FWD2',
      author: { member_openid: 'M1', username: '小明' },
      group_openid: 'G1',
      content: '',
      message_type: 103,
      msg_elements: [{ content: FORWARD_BODY }],
    });
    ok('群里转发（103）也识别', () => assert.strictEqual(got[0]?.forwarded, true));
    ok('群里转发正文抽到', () => assert.ok(got[0].forwardText.includes('在呢')));
  }

  // 3) 递归 msg_elements（嵌套转发）+ 附件占位
  {
    const { client, got } = capture('message');
    client._dispatch('C2C_MESSAGE_CREATE', {
      id: 'FWD3',
      author: { user_openid: 'U1' },
      content: ' ',
      message_type: 102,
      msg_elements: [
        {
          message_type: 102,
          msg_elements: [
            { content: '=== 消息 1 ===\n[消息内容] 外面那层不是正文' },
            { content: '=== 消息 2 ===\n[消息内容] 里层才是', attachments: [{ content_type: 'image/png' }] },
          ],
        },
      ],
    });
    ok('递归下钻取到内层文本', () => assert.ok(got[0].forwardText.includes('里层才是')));
    ok('记录里夹的图片标成 [附件:图片]', () => assert.ok(got[0].forwardText.includes('[附件:图片]')));
  }

  // 4) 普通文本消息不该被误判成转发
  {
    const { client, got } = capture('message');
    client._dispatch('C2C_MESSAGE_CREATE', { id: 'N1', author: { user_openid: 'U1' }, content: '今天好累', message_type: 0 });
    ok('普通消息 forwarded=false', () => assert.strictEqual(got[0]?.forwarded, false));
    ok('普通消息 forwardText 为空', () => assert.strictEqual(got[0].forwardText, ''));
  }

  // 5) brain.chat：forwardText 要进提示词，且不被 240 字截断
  const tmpDir = path.join(__dirname, '..', '.tmp', 'test-forward');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const cfg = {
    brain: { apiKey: 'x', baseURL: 'https://api.deepseek.com', model: 'm', maxTokens: 100, thinking: 'disabled', timeoutMs: 5000, temperature: 1 },
    memory: { enabled: true, maxTurns: 16, maxChars: 8000, autoNotes: false },
    paths: { data: tmpDir, persona: path.join(__dirname, '..', 'src', 'persona.md') },
    style: { enabled: true, minCount: 3 },
    sticker: { enabled: false },
    qq: {},
  };
  const memory = new MemoryStore({ dir: path.join(tmpDir, 'memory'), log });
  const brain = new Brain(cfg, { log, memory, stickers: [] });
  const seen = [];
  brain._postJson = async (url, payload) => {
    seen.push(payload);
    return { status: 200, text: '{}', data: { choices: [{ message: { content: '看完了，明天三点是吧' } }] } };
  };
  const longBody = FORWARD_BODY + '\n' + '补充'.repeat(1000); // 远超 240 字
  await okAsync('chat 把转发正文完整塞进请求', async () => {
    await brain.chat({ id: 'U1', name: '小明', userText: '（转发了一份聊天记录）', forwardText: longBody });
    const msgs = seen[0].messages;
    const last = msgs[msgs.length - 1].content;
    assert.ok(last.includes('他转发了一份聊天记录'), '缺少转发说明');
    assert.ok(last.includes('老地方见'), '正文丢了');
    assert.ok(last.length > 1500, '正文被截断了: ' + last.length);
  });
  await okAsync('转发内容也进了记忆（他接着问细节能看到）', async () => {
    const turns = memory.get('U1').turns;
    assert.ok(turns.some((t) => t.role === 'user' && String(t.content).includes('[转发记录]')));
  });
  await okAsync('转发不算「他平时怎么说话」的样本', async () => {
    const learner = brain.learner;
    assert.ok(!(learner?.texts?.() || []).includes('（转发了一份聊天记录）'));
  });

  // 6) responder：转发消息要真的调模型，不能回「图片/语音/文件我这边看不了」
  const calls = [];
  const fakeBot = {
    sendC2C: async () => ({ ok: true }),
    sendGroup: async () => ({ ok: true }),
    sendTyping: async () => ({ ok: true }),
  };
  let sent = [];
  const fakeBrain = {
    async chat(args) { calls.push(args); return '看完了，明天三点老地方是吧'; },
  };
  const rcfg = {
    qq: { allowFrom: [], allowGroups: [], replyInGroup: true, maxReplyChars: 800, groupAuto: { enabled: true, mode: 'smart' } },
    rhythm: { enabled: false },
    sticker: { enabled: false },
    style: { enabled: true },
    memory: { enabled: true },
    log: {},
  };
  const responder = createResponder({
    cfg: rcfg, bot: fakeBot, brain: fakeBrain, log, memoryStore: null,
    stickers: null, learner: null, groupLog: null, ownerStore: null, modeStore: null,
    sleepFn: async () => {}, rng: () => 0.5,
  });
  await okAsync('responder 对转发消息正常回话', async () => {
    const res = await responder.handle({
      scene: 'c2c', msgId: 'R1', userId: 'U1', userName: '小明',
      content: '（转发了一份聊天记录）', forwarded: true, forwardText: FORWARD_BODY,
      attachments: [], messageType: 102,
    });
    assert.ok(calls.length === 1, '应调一次模型，实际 ' + calls.length);
    assert.ok(calls[0].forwardText.includes('老地方见'), 'forwardText 没传给 brain');
    assert.ok(res.sent && res.sent.length > 0, '没发出回复');
  });

  console.log(passed ? `\n全部通过（${passed} 项）` : '\n没有通过的用例');
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exitCode = 1;
});
