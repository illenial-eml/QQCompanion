'use strict';
/**
 * 潜水模式测试（不联网、不调模型）：
 *   1. 命令识别：说「潜水 / /潜水 / 潜水。」都算，说「今天去潜水了」不算
 *   2. 状态落盘：重启后仍然是潜水状态
 *   3. 他说「潜水」→ 群里回一句确认，之后群里的消息一条都不发（照记群聊日志）
 *   4. 他说「浮上来」→ 回「醒了」+ 潜水期间的群聊小结
 *   5. 别人说「潜水」不算命令
 *   6. 没潜水时问「潜水总结」也能要一份小结
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createResponder } = require('../src/responder');
const { createOwnerStore } = require('../src/owner');
const { createModeStore, matchModeCommand, normalizeCmd } = require('../src/modes');

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
      groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 0, maxPerHour: 99, contextSize: 6 },
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
  };
}

function fakeBrain({ reply = '行', summary = '群1：他们在约周末去爬山' } = {}) {
  const seen = [];
  return {
    seen,
    async chat(args) { seen.push(args); return reply; },
    async summarizeGroupDigest(args) { seen.push({ summarize: args }); return summary; },
  };
}

function fakeGroupLog({ digest = '', record = [] } = {}) {
  return {
    recorded: record,
    record(line) { record.push(line); return true; },
    digest() { return digest; },
    flush() {},
  };
}

const groupMsg = (id, content, over = {}) => ({
  scene: 'group', groupId: 'G1', userId: 'U_' + id, userName: '小明', msgId: id, content, mentioned: false, ...over,
});

(async () => {
  // 1. 命令识别
  {
    assert.equal(matchModeCommand('潜水'), 'silent');
    assert.equal(matchModeCommand('/潜水'), 'silent');
    assert.equal(matchModeCommand('潜水。'), 'silent');
    assert.equal(matchModeCommand(' 静音 '), 'silent');
    assert.equal(matchModeCommand('今天去潜水了'), null, '不是整句命令就不算');
    assert.equal(matchModeCommand('浮上来'), 'wake');
    assert.equal(matchModeCommand('出来'), 'wake');
    assert.equal(matchModeCommand('潜水总结'), 'summary');
    assert.equal(matchModeCommand('嗯'), null);
    assert.equal(normalizeCmd('/浮上来！'), '浮上来');
    console.log('✓ 命令识别（含 / 前缀、句末标点、误判防护）');
  }

  // 2. 状态落盘
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-mode-'));
    const file = path.join(dir, 'state.json');
    const a = createModeStore({ file, cfg: {}, log: silentLog });
    assert.equal(a.isSilent(), false);
    a.set(true, { by: 'Alice' });
    const b = createModeStore({ file, cfg: {}, log: silentLog });
    assert.equal(b.isSilent(), true, '重启后还在潜水');
    assert.ok(b.snapshot().since > 0, '记住了开始时间');
    b.set(false);
    const c = createModeStore({ file, cfg: {}, log: silentLog });
    assert.equal(c.isSilent(), false);
    console.log('✓ 潜水状态落盘，重启后保持');
  }

  // 3. 主人说「潜水」→ 群里闭嘴但照记
  {
    const modeStore = createModeStore({ cfg: {}, log: silentLog });
    const ownerStore = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const bot = fakeBot();
    const brain = fakeBrain();
    const glog = fakeGroupLog({ digest: '## 群里最近在聊什么\n- 群1（最近 2 条）：小红：周末去爬山 ｜ 小刚：算我一个' });
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog, sleepFn: async () => {}, ownerStore, modeStore, groupLog: glog });

    const cmd = await r.handle(groupMsg('C1', '潜水', { userName: 'Alice', userId: 'OWNER1' }));
    assert.equal(cmd.command, 'silent');
    assert.equal(modeStore.isSilent(), true);
    assert.equal(bot.calls.length, 1);
    assert.match(bot.calls[0].content, /潜水/);

    const before = bot.calls.length;
    for (const text of ['@水鸡 你来一下', '谁在', '那明天几点']) {
      const res = await r.handle(groupMsg('M' + text.length, text, { userName: '小红', mentioned: true }));
      assert.equal(res.skipped, 'silent', '潜水期间群里一个字都不发');
    }
    assert.equal(bot.calls.length, before, '潜水期间没有任何发送');
    assert.ok(glog.recorded.length >= 3, '消息仍然被记录进群聊日志');
    console.log('✓ 潜水期间：群里不发言、但消息照记');
  }

  // 4. 说「浮上来」→ 群里只回「醒了」+ 小结私发给主人
  {
    const modeStore = createModeStore({ cfg: { summarize: true, summarizeOnWake: true }, log: silentLog });
    const ownerStore = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const bot = fakeBot();
    const brain = fakeBrain({ summary: '群1：他们在约周末去爬山' });
    const glog = fakeGroupLog({ digest: '## 群里最近在聊什么\n- 群1（最近 2 条）：小红：周末去爬山' });
    const r = createResponder({ cfg: fakeCfg({ ownerIds: ['OWNER_OPENID'] }), bot, brain, log: silentLog, sleepFn: async () => {}, ownerStore, modeStore, groupLog: glog });

    modeStore.set(true, { by: 'Alice' });
    const res = await r.handle(groupMsg('W1', '浮上来', { userName: 'Alice', userId: 'OWNER1' }));
    assert.equal(res.command, 'wake');
    assert.equal(modeStore.isSilent(), false);
    const groupCalls = bot.calls.filter((c) => c.kind === 'group');
    const c2cCalls = bot.calls.filter((c) => c.kind === 'c2c');
    assert.equal(groupCalls.length, 1, '群里只该回一句，实际：' + JSON.stringify(groupCalls));
    assert.match(groupCalls[0].content, /醒/);
    assert.equal(c2cCalls.length, 1, '小结应私发 1 条，实际：' + JSON.stringify(c2cCalls));
    assert.equal(c2cCalls[0].id, 'OWNER_OPENID');
    assert.match(c2cCalls[0].content, /爬山/);
    const summarized = brain.seen.some((s) => s.summarize);
    assert.ok(summarized, '小结走了模型归纳');
    console.log('✓ 浮上来：群里只回「醒了」，小结私发给主人');
  }

  // 5. 别人说「潜水」不算命令
  {
    const modeStore = createModeStore({ cfg: {}, log: silentLog });
    const ownerStore = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const bot = fakeBot();
    const brain = fakeBrain({ reply: '行' });
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog, sleepFn: async () => {}, ownerStore, modeStore });
    const res = await r.handle(groupMsg('N1', '潜水', { userName: '路人甲', userId: 'X1' }));
    assert.equal(modeStore.isSilent(), false, '别人说不管用');
    assert.notEqual(res.command, 'silent');
    console.log('✓ 只有主人的命令才算（别人说「潜水」无效）');
  }

  // 6. 没潜水时也能要小结
  {
    const modeStore = createModeStore({ cfg: { summarize: true, summarizeOnWake: true }, log: silentLog });
    const ownerStore = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const bot = fakeBot();
    const brain = fakeBrain({ summary: '群1：在聊食堂' });
    const glog = fakeGroupLog({ digest: '## 群里最近在聊什么\n- 群1：食堂吃鱼' });
    const r = createResponder({ cfg: fakeCfg({ ownerIds: ['OWNER_OPENID'] }), bot, brain, log: silentLog, sleepFn: async () => {}, ownerStore, modeStore, groupLog: glog });
    const res = await r.handle(groupMsg('S1', '潜水总结', { userName: 'Alice', userId: 'OWNER1' }));
    assert.equal(res.command, 'summary');
    const c2cCalls = bot.calls.filter((c) => c.kind === 'c2c');
    const groupCalls = bot.calls.filter((c) => c.kind === 'group');
    assert.equal(c2cCalls.length, 1, '小结应私发，实际：' + JSON.stringify(bot.calls));
    assert.match(c2cCalls[0].content, /食堂/);
    assert.equal(groupCalls.length, 1, '群里只回一句「私聊发你了」');
    assert.match(groupCalls[0].content, /私聊/);
    console.log('✓ 「潜水总结」随时能要一份群聊小结（私发）');
  }

  // 7. 关闭整套功能时，命令失效
  {
    const modeStore = createModeStore({ cfg: { enabled: false }, log: silentLog });
    assert.equal(modeStore.match('潜水'), null);
    assert.equal(modeStore.isSilent(), false);
    console.log('✓ 关掉 modes.enabled 后命令失效');
  }

  // 8. 关掉「总结群消息」（默认就是关）：浮上来不生成小结、要小结也直接拒绝
  {
    const modeStore = createModeStore({ cfg: { summarize: false, summarizeOnWake: false }, log: silentLog });
    const ownerStore = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const bot = fakeBot();
    const brain = fakeBrain({ summary: '不该被生成' });
    const glog = fakeGroupLog({ digest: '## 群里最近在聊什么\n- 群1：食堂吃鱼' });
    const r = createResponder({ cfg: fakeCfg({ ownerIds: ['OWNER_OPENID'] }), bot, brain, log: silentLog, sleepFn: async () => {}, ownerStore, modeStore, groupLog: glog });

    modeStore.set(true, { by: 'Alice' });
    const wake = await r.handle(groupMsg('W1', '浮上来', { userName: 'Alice', userId: 'OWNER1' }));
    assert.equal(wake.command, 'wake');
    assert.equal(brain.seen.some((s) => s.summarize), false, '不该调模型去总结');
    assert.equal(bot.calls.filter((c) => c.kind === 'c2c').length, 0, '不该私发小结');
    assert.equal(bot.calls.filter((c) => c.kind === 'group').length, 1, '群里只回「醒了。」');

    const sum = await r.handle(groupMsg('W2', '潜水总结', { userName: 'Alice', userId: 'OWNER1' }));
    assert.equal(sum.command, 'summary');
    assert.equal(sum.disabled, true);
    assert.equal(brain.seen.some((s) => s.summarize), false);
    assert.match(bot.calls[bot.calls.length - 1].content, /不总结/);
    console.log('✓ 关掉总结后：浮上来不生成小结、要小结也直接拒绝（省时间）');
  }

  console.log('\n潜水模式测试全部通过 ✅');
})().catch((e) => {
  console.error('✗ 测试失败:', e.message);
  process.exit(1);
});
