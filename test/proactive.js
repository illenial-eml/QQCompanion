'use strict';
/**
 * 主动挑话题：把「谁该被主动搭话、发不发得出去、发失败后怎么处理」这几件事钉死。
 * 官方对个人主体的主动消息限制很严（40034105 / 40054013 / 40034122），所以这里的重点
 * 反而是「不该发的时候千万别发」。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createProactive } = require('../src/proactive');

const log = { info() {}, warn() {}, error() {}, debug() {} };
let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
    passed++;
  } catch (e) {
    console.error('  ✗', name, '->', e.message);
    process.exitCode = 1;
  }
}

const ROOT = path.join(__dirname, '..', '.tmp', 'test-proactive');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function resetDir() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'memory'), { recursive: true });
}
/** 造一份私聊记忆：userTurns 条他自己的话，最后一句在 lastAgo 之前 */
function writeMemory(id, { name = '', userTurns = 3, lastAgo = 10 * HOUR, notes = [] } = {}) {
  const now = Date.now();
  const turns = [];
  for (let i = 0; i < userTurns; i++) {
    turns.push({ role: 'user', content: `我最近在学做饭第${i + 1}天`, at: now - lastAgo - (userTurns - i) * HOUR });
    turns.push({ role: 'assistant', content: '行', at: now - lastAgo - (userTurns - i) * HOUR + 1000 });
  }
  const f = path.join(ROOT, 'memory', id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  fs.writeFileSync(f, JSON.stringify({ id, name, notes, turns, updatedAt: now - lastAgo }, null, 2));
}

function makeMemoryStore() {
  return {
    dir: path.join(ROOT, 'memory'),
    get(id) {
      const f = path.join(this.dir, id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    },
  };
}

function makeBot(failCodes = []) {
  const sent = [];
  const bot = {
    sent,
    async sendC2C(openid, content, opts = {}) {
      const code = failCodes.shift();
      if (code) {
        const e = new Error('发送失败 ' + code);
        e.errCode = code;
        throw e;
      }
      sent.push({ openid, content, opts });
      return { ok: true };
    },
  };
  return bot;
}

function makeBrain(text = '你昨天那条鱼最后煎糊了没') {
  const calls = [];
  return {
    calls,
    async topicFor(args) { calls.push(args); return text; },
  };
}

const quietCfg = { enabled: true, quietHours: [], maxPerDay: 2 };

(async () => {
  console.log('主动挑话题：');

  await ok('关着的时候什么都不做', async () => {
    resetDir(); writeMemory('U1');
    const p = createProactive({ cfg: { enabled: false }, bot: makeBot(), brain: makeBrain(), memory: makeMemoryStore(), log });
    assert.strictEqual((await p.maybeRun()).skipped, 'disabled');
  });

  await ok('深夜里不发（23–8 点）', async () => {
    resetDir(); writeMemory('U1');
    const p = createProactive({ cfg: { ...quietCfg, quietHours: [23, 8] }, bot: makeBot(), brain: makeBrain(), memory: makeMemoryStore(), log });
    // 北京时间 02:00 = UTC 18:00
    const ts = Date.UTC(2026, 9, 26, 18, 0, 0);
    assert.strictEqual((await p.maybeRun(ts)).skipped, 'quiet-hours');
  });

  await ok('没有记忆时没有候选人', async () => {
    resetDir();
    const p = createProactive({ cfg: quietCfg, bot: makeBot(), brain: makeBrain(), memory: makeMemoryStore(), log });
    assert.strictEqual((await p.maybeRun()).skipped, 'no-candidate');
  });

  await ok('对方刚说完话（不到 idleHours）不打扰', async () => {
    resetDir(); writeMemory('U1', { lastAgo: 30 * 60 * 1000 }); // 半小时前
    const p = createProactive({ cfg: { ...quietCfg, idleHours: 6 }, bot: makeBot(), brain: makeBrain(), memory: makeMemoryStore(), log });
    assert.strictEqual((await p.maybeRun()).skipped, 'no-candidate');
  });

  await ok('话太少的人不主动搭话', async () => {
    resetDir(); writeMemory('U1', { userTurns: 2 });
    const p = createProactive({ cfg: { ...quietCfg, minUserTurns: 3 }, bot: makeBot(), brain: makeBrain(), memory: makeMemoryStore(), log });
    assert.strictEqual((await p.maybeRun()).skipped, 'no-candidate');
  });

  await ok('正常情况：先走互动召回（is_wakeup），并记下这次的开场白', async () => {
    resetDir(); writeMemory('U1', { name: '小明', userTurns: 4 });
    const bot = makeBot();
    const brain = makeBrain('鱼煎糊了没');
    const p = createProactive({ cfg: quietCfg, bot, brain, memory: makeMemoryStore(), log, rng: () => 0.5 });
    const res = await p.maybeRun();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.isWakeup, true);
    assert.strictEqual(bot.sent.length, 1);
    assert.strictEqual(bot.sent[0].opts.isWakeup, true);
    assert.ok(brain.calls[0].recentLines.length > 0, '没把对方最近说的话交给模型');
    assert.ok(brain.calls[0].recentLines[0].includes('学做饭'), '话题来源不对: ' + brain.calls[0].recentLines[0]);
    assert.strictEqual(p.snapshot().count, 1);
  });

  await ok('同一个人 72 小时内不再主动找他', async () => {
    resetDir(); writeMemory('U1', { userTurns: 4 });
    const bot = makeBot();
    const p = createProactive({ cfg: quietCfg, bot, brain: makeBrain(), memory: makeMemoryStore(), log });
    await p.maybeRun();
    const second = await p.maybeRun();
    assert.strictEqual(second.skipped, 'no-candidate');
    assert.strictEqual(bot.sent.length, 1);
  });

  await ok('每天条数到上限就停', async () => {
    resetDir();
    writeMemory('U1', { userTurns: 4, lastAgo: 10 * HOUR });
    writeMemory('U2', { userTurns: 4, lastAgo: 11 * HOUR });
    const bot = makeBot();
    const p = createProactive({ cfg: { ...quietCfg, maxPerDay: 1 }, bot, brain: makeBrain(), memory: makeMemoryStore(), log });
    assert.strictEqual((await p.maybeRun()).ok, true);
    assert.strictEqual((await p.maybeRun()).skipped, 'daily-cap');
    assert.strictEqual(bot.sent.length, 1);
  });

  await ok('对方关掉了主动消息（40054013）→ 记住他，以后不再试', async () => {
    resetDir(); writeMemory('U1', { userTurns: 4 });
    const bot = makeBot([40054013]);
    const p = createProactive({ cfg: quietCfg, bot, brain: makeBrain(), memory: makeMemoryStore(), log });
    const res = await p.maybeRun();
    assert.strictEqual(res.skipped, 'send-failed');
    assert.strictEqual(p.snapshot().blockedCount, 1);
    assert.strictEqual((await p.maybeRun()).skipped, 'no-candidate');
  });

  await ok('官方不给权限（40034105）→ 不再重试', async () => {
    resetDir(); writeMemory('U1', { userTurns: 4 });
    const bot = makeBot([40034105]);
    const p = createProactive({ cfg: quietCfg, bot, brain: makeBrain(), memory: makeMemoryStore(), log });
    assert.strictEqual((await p.maybeRun()).skipped, 'send-failed');
    assert.strictEqual(p.snapshot().blockedCount, 1);
  });

  await ok('互动召回额度用完（40034122）→ 自动退回普通主动消息', async () => {
    resetDir(); writeMemory('U1', { userTurns: 4 });
    const bot = makeBot([40034122]); // 第一次（召回）失败，第二次（普通主动）成功
    const p = createProactive({ cfg: quietCfg, bot, brain: makeBrain(), memory: makeMemoryStore(), log });
    const res = await p.maybeRun();
    assert.strictEqual(res.ok, true, '应该退回普通主动消息并成功');
    assert.strictEqual(res.isWakeup, false);
    assert.strictEqual(bot.sent.length, 1);
    assert.strictEqual(bot.sent[0].opts.isWakeup, false);
  });

  await ok('quiet 时段、潜水模式都不发', async () => {
    resetDir(); writeMemory('U1', { userTurns: 4 });
    const bot = makeBot();
    const p = createProactive({ cfg: quietCfg, bot, brain: makeBrain(), memory: makeMemoryStore(), log, modeStore: { isSilent: () => true } });
    assert.strictEqual((await p.maybeRun()).skipped, 'silent');
    assert.strictEqual(bot.sent.length, 0);
  });

  await ok('onlyOwner=true 时只找主人', async () => {
    resetDir();
    writeMemory('U1', { userTurns: 4, lastAgo: 10 * HOUR });
    writeMemory('U2', { userTurns: 4, lastAgo: 10 * HOUR });
    const bot = makeBot();
    const p = createProactive({
      cfg: { ...quietCfg, onlyOwner: true }, bot, brain: makeBrain(), memory: makeMemoryStore(), log,
      ownerStore: { match: (m) => ({ owner: m.userId === 'U2', reason: null }) },
    });
    await p.maybeRun();
    assert.strictEqual(bot.sent.length, 1);
    assert.strictEqual(bot.sent[0].openid, 'U2');
  });

  await ok('模型没生成出话就不发（不刷屏）', async () => {
    resetDir(); writeMemory('U1', { userTurns: 4 });
    const bot = makeBot();
    const p = createProactive({ cfg: quietCfg, bot, brain: makeBrain(''), memory: makeMemoryStore(), log });
    assert.strictEqual((await p.maybeRun()).skipped, 'empty-topic');
    assert.strictEqual(bot.sent.length, 0);
  });

  await ok('状态落盘后重启还记得「上次找他是什么时候」', async () => {
    resetDir(); writeMemory('U1', { userTurns: 4 });
    const statePath = path.join(ROOT, 'proactive.json');
    const bot = makeBot();
    const p1 = createProactive({ cfg: quietCfg, bot, brain: makeBrain(), memory: makeMemoryStore(), log, statePath });
    await p1.maybeRun();
    const p2 = createProactive({ cfg: quietCfg, bot: makeBot(), brain: makeBrain(), memory: makeMemoryStore(), log, statePath });
    assert.strictEqual(p2.snapshot().count, 1);
    assert.strictEqual((await p2.maybeRun()).skipped, 'no-candidate');
  });

  await ok('主动消息分成两段：先「想起你」再问具体的事', async () => {
    resetDir(); writeMemory('U1', { userTurns: 4 });
    const bot = makeBot();
    const brain = makeBrain('忽然想起你说要考试\n考得怎么样了');
    const p = createProactive({
      cfg: { ...quietCfg, channel: 'active', parts: 2, pieceGapMs: 0 },
      bot, brain, memory: makeMemoryStore(), log,
    });
    const r = await p.maybeRun();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.parts, 2, '应该发两段');
    assert.strictEqual(bot.sent.length, 2, '两段各发一条');
    assert.strictEqual(bot.sent[0].content, '忽然想起你说要考试');
    assert.strictEqual(bot.sent[1].content, '考得怎么样了');
    assert.strictEqual(brain.calls[0].parts, 2, '要告诉模型分几段');
  });

  await ok('parts=1 时还是一整句（不多发）', async () => {
    resetDir(); writeMemory('U1', { userTurns: 4 });
    const bot = makeBot();
    const p = createProactive({
      cfg: { ...quietCfg, channel: 'active', parts: 1 },
      bot, brain: makeBrain('你昨天那条鱼糊了没'), memory: makeMemoryStore(), log,
    });
    const r = await p.maybeRun();
    assert.strictEqual(r.parts, 1);
    assert.strictEqual(bot.sent.length, 1);
  });

  console.log(passed ? `\n全部通过（${passed} 项）` : '\n没有通过的用例');
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exitCode = 1;
});
