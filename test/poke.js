'use strict';
/**
 * 戳一戳（拍一拍）+ 表情回复。
 *
 * 背景：官方 wiki 只给了频道里的「表情表态」，单聊/群聊既没有 reaction 也没有
 * 明文的「戳一戳」事件/接口。所以这里做的是：
 *   1. qq.js 宽松匹配 /NUDGE|POKE/ 事件名 —— 网关要是推，就归一化成 poke 事件；
 *   2. qq.js.sendNudge() 试 /v2/users/{openid}/nudge 与 /v2/groups/{id}/nudge，
 *      官方没这接口时返回 { ok:false, unsupported:true }，不抛错；
 *   3. responder.handlePoke() 收到后：能戳就戳回去（没有就退化成说话），并回一句；
 *   4. 「表情回复」= 只发一个表情图（模型只输出 [[表情:x]] 时走这条），
 *      在群里/私聊都等于「用表情回了他这条消息」。
 */
const assert = require('node:assert');

const { QQBotClient } = require('../src/qq');
const { createResponder } = require('../src/responder');
const { Brain } = require('../src/brain');
const { MemoryStore } = require('../src/memory');

const log = { info() {}, warn() {}, error() {}, debug() {} };
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

function makeClient(extra = {}) {
  const client = new QQBotClient({ qq: { appId: '1', clientSecret: 'x', ...extra } }, { log });
  client.token = 'T';
  client.tokenExpireAt = Date.now() + 3600_000;
  return client;
}

/** 假的 bot：记录发出去的东西 */
function fakeBot({ nudgeOk = false } = {}) {
  const calls = { c2c: [], group: [], nudge: [], sticker: [] };
  return {
    calls,
    sendC2C: async (openid, content, opts = {}) => { calls.c2c.push({ openid, content, opts }); return {}; },
    sendGroup: async (groupId, content, opts = {}) => { calls.group.push({ groupId, content, opts }); return {}; },
    sendNudge: async (target) => {
      calls.nudge.push(target);
      return nudgeOk ? { ok: true, path: '/v2/users/X/nudge' } : { ok: false, unsupported: true, reason: 'api-not-found', status: 404 };
    },
  };
}

function baseCfg(extra = {}) {
  return {
    qq: {
      allowFrom: [],
      allowGroups: [],
      replyInGroup: true,
      botNames: ['水鸡'],
      groupAuto: { enabled: false },
      poke: { enabled: true, pokeBack: true, minIntervalSec: 0 },
      ...extra,
    },
    brain: { model: 'deepseek-flash', maxTokens: 200, timeoutMs: 5000 },
    memory: { maxTurns: 16, maxChars: 8000 },
    rhythm: { enabled: false },
    sticker: { enabled: false },
    paths: { data: '.tmp/poke-data', memory: '.tmp/poke-data/memory', persona: 'src/persona.md' },
  };
}

function makeResponder(cfg, bot, extra = {}) {
  const brain = { chat: async () => '（模型回话）' };
  return { responder: createResponder({ cfg, bot, brain, log, rng: () => 0, sleepFn: async () => {}, ...extra }), brain };
}

(async () => {
  console.log('戳一戳 / 表情回复：');

  // 1) 事件归一化：单聊
  ok('单聊戳一戳事件被识别', () => {
    const client = makeClient();
    const got = [];
    client.on('poke', (p) => got.push(p));
    client._dispatch('C2C_NUDGE_CREATE', { user_openid: 'U1', nickname: '小明', timestamp: 111 });
    assert.equal(got.length, 1);
    assert.equal(got[0].scene, 'c2c');
    assert.equal(got[0].userId, 'U1');
    assert.equal(got[0].userName, '小明');
    assert.equal(got[0].type, 'C2C_NUDGE_CREATE');
  });

  // 2) 事件归一化：群聊
  ok('群聊拍一拍事件被识别', () => {
    const client = makeClient();
    const got = [];
    client.on('poke', (p) => got.push(p));
    client._dispatch('GROUP_NUDGE_CREATE', { group_openid: 'G1', member_openid: 'M1', nickname: '小明' });
    assert.equal(got.length, 1);
    assert.equal(got[0].scene, 'group');
    assert.equal(got[0].groupId, 'G1');
    assert.equal(got[0].userId, 'M1');
  });

  // 3) debugEvents：没处理的事件打到 info
  ok('debugEvents 打开时会把未知事件名打出来', () => {
    const lines = [];
    const client = new QQBotClient(
      { qq: { appId: '1', clientSecret: 'x', debugEvents: true } },
      { log: { info: (...a) => lines.push(a.join(' ')), warn() {}, error() {}, debug() {} } }
    );
    client._dispatch('SOME_NEW_EVENT', { hello: 1 });
    assert.ok(lines.some((l) => l.includes('SOME_NEW_EVENT') && l.includes('收到未处理的事件')), lines.join('\n'));
  });

  // 4) sendNudge：单聊走 /v2/users/{openid}/nudge
  await okAsync('sendNudge 单聊路径与请求体正确', async () => {
    const client = makeClient();
    const seen = [];
    client.api = async (method, p, body) => { seen.push({ method, p, body }); return { ok: true }; };
    const r = await client.sendNudge({ scene: 'c2c', userId: 'U1', msgId: 'M1' });
    assert.equal(r.ok, true);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].p, '/v2/users/U1/nudge');
    assert.equal(seen[0].body.msg_id, 'M1');
  });

  // 5) sendNudge：群聊先试群路径
  await okAsync('sendNudge 群聊先试 /v2/groups/{id}/nudge', async () => {
    const client = makeClient();
    const seen = [];
    client.api = async (method, p) => { seen.push(p); return {}; };
    const r = await client.sendNudge({ scene: 'group', groupId: 'G1', userId: 'M1' });
    assert.equal(r.ok, true);
    assert.equal(seen[0], '/v2/groups/G1/nudge');
  });

  // 6) 官方没接口时：返回 unsupported，不抛错
  await okAsync('接口不存在时 sendNudge 返回 unsupported', async () => {
    const client = makeClient();
    client.api = async () => {
      const e = new Error('POST /v2/users/U1/nudge -> 404');
      e.status = 404;
      throw e;
    };
    const r = await client.sendNudge({ scene: 'c2c', userId: 'U1' });
    assert.equal(r.ok, false);
    assert.equal(r.unsupported, true);
    assert.equal(r.status, 404);
  });

  // 7) handlePoke：有 msg_id 时走被动回复
  await okAsync('handlePoke 带 msg_id 时用被动回复', async () => {
    const bot = fakeBot();
    const { responder } = makeResponder(baseCfg(), bot);
    const r = await responder.handlePoke({ type: 'C2C_NUDGE_CREATE', scene: 'c2c', userId: 'U1', msgId: 'PM1' });
    assert.ok(r.reply, '应该回一句话');
    assert.equal(bot.calls.c2c.length, 1);
    assert.equal(bot.calls.c2c[0].opts.msgId, 'PM1');
    assert.equal(bot.calls.c2c[0].opts.passive, true);
    assert.equal(bot.calls.nudge.length, 1, '应该尝试戳回去');
  });

  // 8) handlePoke：没有 msg_id 时退回主动消息（先试互动召回）
  await okAsync('handlePoke 无 msg_id 时走主动消息（先互动召回）', async () => {
    const bot = fakeBot();
    const { responder } = makeResponder(baseCfg(), bot);
    await responder.handlePoke({ type: 'C2C_NUDGE_CREATE', scene: 'c2c', userId: 'U1' });
    assert.equal(bot.calls.c2c.length, 1);
    assert.equal(bot.calls.c2c[0].opts.isWakeup, true, '第一次应该试 is_wakeup');
  });

  // 9) 冷却：同一个人短时间内只理一次
  await okAsync('同一会话冷却内不理第二次', async () => {
    const bot = fakeBot();
    const cfg = baseCfg();
    cfg.qq.poke.minIntervalSec = 60;
    const { responder } = makeResponder(cfg, bot);
    const first = await responder.handlePoke({ type: 'NUDGE', scene: 'c2c', userId: 'U1', msgId: 'A' });
    assert.ok(first.reply);
    const second = await responder.handlePoke({ type: 'NUDGE', scene: 'c2c', userId: 'U1', msgId: 'B' });
    assert.equal(second.skipped, 'poke-cooldown');
    assert.equal(bot.calls.c2c.length, 1);
  });

  // 10) 关掉开关 / 潜水时不理
  await okAsync('poke.enabled=false 时不理；群里潜水时也不理', async () => {
    const bot = fakeBot();
    const cfg = baseCfg();
    cfg.qq.poke = { enabled: false };
    const { responder } = makeResponder(cfg, bot);
    assert.equal((await responder.handlePoke({ type: 'NUDGE', scene: 'c2c', userId: 'U1' })).skipped, 'poke-off');

    const bot2 = fakeBot();
    const silentStore = { isSilent: () => true, settings: { enabled: true } };
    const { responder: r2 } = makeResponder(baseCfg(), bot2, { modeStore: silentStore });
    assert.equal((await r2.handlePoke({ type: 'NUDGE', scene: 'group', groupId: 'G1', userId: 'M1' })).skipped, 'silent');
    assert.equal(bot2.calls.group.length, 0);
  });

  // 11) pokeBack 关掉就不调 sendNudge
  await okAsync('poke.pokeBack=false 时不尝试戳回去', async () => {
    const bot = fakeBot();
    const cfg = baseCfg();
    cfg.qq.poke = { enabled: true, pokeBack: false, minIntervalSec: 0 };
    const { responder } = makeResponder(cfg, bot);
    const r = await responder.handlePoke({ type: 'NUDGE', scene: 'c2c', userId: 'U1', msgId: 'M' });
    assert.equal(bot.calls.nudge.length, 0);
    assert.ok(r.reply);
  });

  // 11b) 戳不回去时：单聊发一个「正在输入」作为近似动作
  await okAsync('戳不回去时单聊发「正在输入」示意', async () => {
    const bot = fakeBot({ nudgeOk: false });
    const typings = [];
    bot.sendTyping = async (openid, opts) => { typings.push({ openid, opts }); return {}; };
    const cfg = baseCfg();
    cfg.qq.poke = { enabled: true, pokeBack: true, minIntervalSec: 0, typingFallback: true };
    const { responder } = makeResponder(cfg, bot);
    const r = await responder.handlePoke({ type: 'NUDGE', scene: 'c2c', userId: 'U1', msgId: 'M9' });
    assert.equal(typings.length, 1, '应该发一次正在输入');
    assert.equal(typings[0].openid, 'U1');
    assert.equal(typings[0].opts.msgId, 'M9');
    assert.equal(r.typing, true);
  });

  // 11c) typingFallback=false 时不发「正在输入」；群里也不发（官方只支持单聊）
  await okAsync('typingFallback 可关；群聊不发「正在输入」', async () => {
    const bot = fakeBot({ nudgeOk: false });
    let n = 0;
    bot.sendTyping = async () => { n++; return {}; };
    const cfg = baseCfg();
    cfg.qq.poke = { enabled: true, pokeBack: true, minIntervalSec: 0, typingFallback: false };
    const { responder } = makeResponder(cfg, bot);
    await responder.handlePoke({ type: 'NUDGE', scene: 'c2c', userId: 'U1', msgId: 'M1' });
    assert.equal(n, 0, 'typingFallback=false 时不该发');

    const bot2 = fakeBot({ nudgeOk: false });
    let n2 = 0;
    bot2.sendTyping = async () => { n2++; return {}; };
    const cfg2 = baseCfg();
    cfg2.qq.poke = { enabled: true, pokeBack: true, minIntervalSec: 0, typingFallback: true };
    const { responder: r2 } = makeResponder(cfg2, bot2);
    await r2.handlePoke({ type: 'NUDGE', scene: 'group', groupId: 'G1', userId: 'M1', msgId: 'M2' });
    assert.equal(n2, 0, '群聊不该发正在输入');
  });

  // 12) poke.useModel=true 时用模型的话
  await okAsync('poke.useModel=true 时用模型生成回应', async () => {
    const bot = fakeBot();
    const cfg = baseCfg();
    cfg.qq.poke = { enabled: true, pokeBack: false, minIntervalSec: 0, useModel: true };
    let asked = null;
    const brain = { chat: async (args) => { asked = args; return '戳我干嘛呀'; } };
    const responder = createResponder({ cfg, bot, brain, log, rng: () => 0, sleepFn: async () => {} });
    const r = await responder.handlePoke({ type: 'NUDGE', scene: 'c2c', userId: 'U1', msgId: 'M2' });
    assert.equal(r.reply, '戳我干嘛呀');
    assert.ok(asked && asked.userText.includes('戳'));
    assert.equal(bot.calls.c2c[0].content, '戳我干嘛呀');
  });

  // 13) 表情回复：模型只输出 [[表情:x]] → 只发一张表情图，不带文字
  await okAsync('只回表情时：发图片、不发明文', async () => {
    const sent = [];
    const stickerSvc = {
      sessionKey: () => 'k',
      canSend: () => true,
      send: async (msg, sticker, seq, opts) => { sent.push({ sticker, seq, opts, msgId: msg.msgId }); return { ok: true }; },
    };
    const list = [{ name: '笑死', tags: ['笑'], file: 'memes/x.jpg' }];
    const brain = { chat: async () => '[[表情:笑死]]' };
    const bot = fakeBot();
    const cfg = baseCfg();
    cfg.sticker = { enabled: true, minGapMs: 0 };
    const storage = new MemoryStore({ dir: '.tmp/poke-data/memory2', maxTurns: 5, maxChars: 2000, log });
    const responder = createResponder({
      cfg, bot, brain, log, stickers: { list, service: stickerSvc }, memoryStore: storage,
      sleepFn: async () => {}, rng: () => 0,
    });
    const res = await responder.handle({
      scene: 'c2c', msgId: 'MID1', userId: 'U1', userName: '小明', content: '哈哈哈这也太蠢了', attachments: [], timestamp: Date.now(),
    });
    assert.equal(res.chunks.length, 0, '不该有文字分段');
    assert.equal(bot.calls.c2c.length, 0, '不该发文字消息');
    assert.equal(sent.length, 1, '应该发一张表情');
    assert.equal(sent[0].sticker.name, '笑死');
    assert.equal(sent[0].msgId, 'MID1', '表情要挂在对方那条消息上（等于表情回复）');
  });

  // 14) 提示词里给了「只回表情」的写法
  ok('提示词写明了「可以只回一个表情」', () => {
    const mem = new MemoryStore({ dir: '.tmp/poke-data/memory3', maxTurns: 5, maxChars: 2000, log });
    const brain = new Brain(
      {
        brain: { model: 'deepseek-flash', apiKey: 'x', temperature: 1, maxTokens: 100, timeoutMs: 1000 },
        memory: { maxTurns: 5, maxChars: 2000 },
        sticker: { enabled: true },
        style: { enabled: false, minCount: 3 },
        qq: { botNames: ['水鸡'] },
        paths: { data: '.tmp/poke-data', memory: '.tmp/poke-data/memory3', persona: 'src/persona.md' },
      },
      { log, memory: mem, stickers: [{ name: '笑死', tags: ['笑'] }] }
    );
    const p = brain.systemPrompt({ turns: [], notes: [], name: '小明' }, { scene: 'c2c' });
    assert.ok(p.includes('只写'), '应该说明可以只写表情标记');
    assert.ok(p.includes('[[表情:名字]]'), '应该给出写法');
  });

  console.log(`\n通过 ${passed} 项`);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
