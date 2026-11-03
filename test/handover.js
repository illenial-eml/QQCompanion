'use strict';
/**
 * 手动接管测试（不联网、不调模型）：
 *   1. 口令识别：「我上 / 我上了 / /我上。 / 换我上」→ takeover；「你上 / 你上号 / 交给你」→ release
 *      误判防护：「我上号了」「你上次说的」→ null
 *   2. 状态落盘：重启后仍然是「你上」
 *   3. 他说「我上」→ 回一句确认，之后群里/私聊一个字都不发（消息照记）
 *   4. 他说「你上」→ 恢复回话
 *   5. 别人说「我上」不算（只有主人能接管）
 *   6. 接管期间戳一戳也不理
 *   7. 接管期间不许主动挑话题
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createResponder } = require('../src/responder');
const { createOwnerStore } = require('../src/owner');
const { createHandoverStore, matchHandoverCommand, normalizeCmd } = require('../src/handover');
const { createProactive } = require('../src/proactive');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function fakeCfg(qq = {}) {
  return {
    root: path.join(__dirname, '..'),
    paths: { data: '', memory: '', persona: '' },
    qq: {
      allowFrom: [],
      allowGroups: [],
      replyInGroup: true,
      maxReplyChars: 100,
      typing: false,
      botNames: ['水鸡'],
      groupAuto: { enabled: false },
      ...qq,
    },
    rhythm: { enabled: false },
    brain: { model: 'x', maxTokens: 100, temperature: 0.5, thinking: 'disabled' },
    memory: { enabled: false, maxTurns: 10, maxChars: 1000 },
    sticker: { enabled: false },
    style: { enabled: false },
  };
}

function fakeBot() {
  const calls = [];
  return {
    calls,
    async sendC2C(id, content, { msgId } = {}) { calls.push({ kind: 'c2c', id, content, msgId }); return { id: 'ok' }; },
    async sendGroup(id, content, { msgId } = {}) { calls.push({ kind: 'group', id, content, msgId }); return { id: 'ok' }; },
    async sendTyping() { return { ok: true }; },
    // 戳一戳回戳：responder.handlePoke 会用到（小号版走 OneBot 时有这个接口，官方版没有）
    async sendNudge() { return { ok: true }; },
  };
}

function fakeBrain({ reply = '收到' } = {}) {
  const seen = [];
  return {
    seen,
    async chat(args) { seen.push(args); return reply; },
  };
}

const groupMsg = (id, content, over = {}) => ({
  scene: 'group', groupId: 'G1', userId: 'U_' + id, userName: '小明', msgId: id, content, mentioned: true, ...over,
});
const c2cMsg = (id, content, over = {}) => ({
  scene: 'c2c', userId: 'OWNER1', userName: 'Alice', msgId: id, content, mentioned: true, ...over,
});

(async () => {
  // 1. 口令识别
  {
    assert.equal(matchHandoverCommand('我上'), 'takeover');
    assert.equal(matchHandoverCommand('  我上了 '), 'takeover');
    assert.equal(matchHandoverCommand('/我上。'), 'takeover');
    assert.equal(matchHandoverCommand('换我上'), 'takeover');
    assert.equal(matchHandoverCommand('你上'), 'release');
    assert.equal(matchHandoverCommand('你上号'), 'release');
    assert.equal(matchHandoverCommand('交给你。'), 'release');
    assert.equal(matchHandoverCommand('我上号了'), null, '带别的话就不算');
    assert.equal(matchHandoverCommand('你上次说的那个'), null);
    assert.equal(matchHandoverCommand('嗯'), null);
    assert.equal(normalizeCmd('/我上！'), '我上');
    assert.equal(matchHandoverCommand('我上', { enabled: false }), null);
    console.log('✓ 口令识别（含 / 前缀、句末标点、误判防护）');
  }

  // 2. 状态落盘
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-handover-'));
    const file = path.join(dir, 'handover.json');
    const a = createHandoverStore({ file, cfg: {}, log: silentLog });
    assert.equal(a.isActive(), false, '默认是「它上」');
    a.set(true, { by: 'Alice' });
    const b = createHandoverStore({ file, cfg: {}, log: silentLog });
    assert.equal(b.isActive(), true, '重启后仍在接管');
    assert.ok(b.since() > 0);
    b.set(false, { by: 'Alice' });
    const c = createHandoverStore({ file, cfg: {}, log: silentLog });
    assert.equal(c.isActive(), false);
    console.log('✓ 接管状态落盘，重启后保持');
  }

  // 2b. 自动过期：说了「我上」忘了说「你上」，超过 autoReleaseMinutes 要自动交回
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-handover-exp-'));
    const file = path.join(dir, 'handover.json');
    const logs = [];
    const log = { info: (m) => logs.push(m), warn() {}, error() {}, debug() {} };
    let t = 1_000_000;
    const a = createHandoverStore({ file, cfg: { autoReleaseMinutes: 120 }, log, now: () => t });
    a.set(true, { by: 'Alice' });
    t += 60_000;
    assert.equal(a.isActive(), true, '1 分钟时仍然接管中');
    t += 120 * 60_000;
    assert.equal(a.isActive(), false, '超过 120 分钟应自动交回');
    assert.ok(logs.some((m) => /自动交回/.test(m)), '应打一行「自动交回」');
    // 落盘也是 false（重启后不会又闭着嘴）
    const b = createHandoverStore({ file, cfg: { autoReleaseMinutes: 120 }, log, now: () => t });
    assert.equal(b.isActive(), false, '过期状态要写回磁盘');
    // autoReleaseMinutes: 0 = 永不过期
    const c = createHandoverStore({ file, cfg: { autoReleaseMinutes: 0 }, log, now: () => t });
    c.set(true, { by: 'Alice' });
    t += 999 * 60_000;
    assert.equal(c.isActive(), true, '0 表示永不过期');
    console.log('✓ 接管超过 autoReleaseMinutes 自动交回（0 = 永不过期）');
  }

  // 3/4. 他说「我上」→ 闭嘴；「你上」→ 恢复
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-handover2-'));
    const handoverStore = createHandoverStore({ file: path.join(dir, 'handover.json'), cfg: {}, log: silentLog });
    const ownerStore = createOwnerStore({ cfg: { ids: ['OWNER1'] }, log: silentLog });
    const bot = fakeBot();
    const brain = fakeBrain();
    const r = createResponder({
      cfg: fakeCfg(), bot, brain, log: silentLog, sleepFn: async () => {},
      ownerStore, handoverStore,
    });

    const take = await r.handle(c2cMsg('H1', '我上'));
    assert.equal(take.command, 'takeover');
    assert.equal(handoverStore.isActive(), true);
    assert.equal(bot.calls.length, 1, '应只回一句确认');
    assert.match(bot.calls[0].content, /你聊/);

    const quiet = await r.handle(c2cMsg('H2', '在吗'));
    assert.equal(quiet.skipped, 'handover');
    assert.equal(bot.calls.length, 1, '接管期间服务一个字都不发');

    const quietGroup = await r.handle(groupMsg('H3', '@水鸡 说话啊'));
    assert.equal(quietGroup.skipped, 'handover');
    assert.equal(bot.calls.length, 1, '群里 @ 也不回');

    const release = await r.handle(c2cMsg('H4', '你上'));
    assert.equal(release.command, 'release');
    assert.equal(handoverStore.isActive(), false);
    assert.equal(bot.calls.length, 2, '交回时回一句');

    await r.handle(c2cMsg('H5', '在吗'));
    assert.ok(bot.calls.length >= 3, '交回后恢复回话');
    console.log('✓ 「我上」闭嘴、「你上」恢复（私聊 + 群 @ 都不发）');
  }

  // 5. 别人说「我上」不算
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-handover3-'));
    const handoverStore = createHandoverStore({ file: path.join(dir, 'handover.json'), cfg: {}, log: silentLog });
    const ownerStore = createOwnerStore({ cfg: { ids: ['OWNER1'] }, log: silentLog });
    const bot = fakeBot();
    const r = createResponder({
      cfg: fakeCfg(), bot, brain: fakeBrain(), log: silentLog, sleepFn: async () => {},
      ownerStore, handoverStore,
    });
    const res = await r.handle(groupMsg('X1', '我上', { userName: '路人甲', userId: 'X1' }));
    assert.equal(handoverStore.isActive(), false, '别人说不管用');
    assert.notEqual(res.command, 'takeover');
    console.log('✓ 只有主人能接管（别人说「我上」无效）');
  }

  // 6. 接管期间不理戳一戳
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-handover4-'));
    const handoverStore = createHandoverStore({ file: path.join(dir, 'handover.json'), cfg: {}, log: silentLog });
    handoverStore.set(true, { by: 'Alice' });
    const bot = fakeBot();
    const r = createResponder({
      cfg: fakeCfg(), bot, brain: fakeBrain(), log: silentLog, sleepFn: async () => {},
      handoverStore,
    });
    const res = await r.handlePoke({ scene: 'c2c', userId: 'OWNER1', timestamp: Date.now() });
    assert.equal(res.skipped, 'handover');
    assert.equal(bot.calls.length, 0);
    console.log('✓ 接管期间不理戳一戳');
  }

  // 7. 接管期间不许主动挑话题
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-handover5-'));
    const handoverStore = createHandoverStore({ file: path.join(dir, 'handover.json'), cfg: {}, log: silentLog });
    handoverStore.set(true, { by: 'Alice' });
    const proactive = createProactive({
      cfg: { enabled: true, channel: 'active', quietHours: [0, 24] },
      bot: fakeBot(), brain: fakeBrain(), memory: null, log: silentLog,
      handoverStore, statePath: path.join(dir, 'proactive.json'),
    });
    const res = await proactive.maybeRun(Date.now());
    assert.equal(res.skipped, 'handover');
    console.log('✓ 接管期间不主动开口');
  }

  console.log('\n全部通过 ✅');
})().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
