'use strict';
/**
 * 「只叫名字才接」+「挨骂直接回嘴」测试（不联网、不调模型）
 *   1) 群里你说普通话（没叫水鸡、没 @）→ 不接、也不调模型
 *   2) 群里你句子里带「水鸡」→ 接
 *   3) 群里你 @ 它（mentioned=true）→ 接
 *   4) 私聊你说话 → 照常接（不受影响）
 *   5) 你的潜水/群名命令，即使没叫名字也照常生效
 *   6) 群友带脏字且点名骂它 → 直接回嘴：不吃冷却、不走 PASS、提示词里带「有人在骂你」
 *   7) 群友 @ 它骂 → 回嘴
 *   8) 群友自己吐槽「这游戏真垃圾」（没冲它）→ 不算恶意，正常走流程
 *   9) 群友用「你个 XX」句式但不点名 → 算冲它来
 *  10) hostile.enabled=false → 不反击
 *  11) 你自己骂它（主人）→ 不算恶意，且只有叫了名字才接
 */
const assert = require('node:assert');
const path = require('node:path');

const { createResponder } = require('../src/responder');
const { createOwnerStore } = require('../src/owner');
const { createGroupLog } = require('../src/grouplog');
const { createModeStore } = require('../src/modes');
const { detectHostile, findInsults } = require('../src/hostile');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function fakeCfg(qq = {}) {
  return {
    qq: {
      allowFrom: [],
      allowGroups: [],
      replyInGroup: true,
      maxReplyChars: 100,
      typing: false,
      botNames: ['水鸡', '机器人', '小D'],
      ownerNames: ['Alice'],
      ownerIds: [],
      groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 0, maxPerHour: 99, contextSize: 6 },
      ...qq,
    },
    rhythm: { enabled: false },
    modes: { enabled: true },
  };
}

function fakeBot() {
  const calls = [];
  return {
    calls,
    async sendC2C(id, content, opts = {}) { calls.push({ kind: 'c2c', id, content, ...opts }); return { id: 'ok' }; },
    async sendGroup(id, content, opts = {}) { calls.push({ kind: 'group', id, content, ...opts }); return { id: 'ok' }; },
    async sendTyping() { return { ok: true }; },
  };
}

function fakeBrain(reply = '你才垃圾') {
  const seen = [];
  return {
    seen,
    async chat(args) { seen.push(args); return reply; },
    async summarizeGroupDigest() { return '小结'; },
  };
}

const msg = (id, content, over = {}) => ({
  scene: 'group', groupId: 'G1', userId: 'U_OWNER', userName: 'Alice',
  msgId: id, content, mentioned: false, ...over,
});

(async () => {
  // 1. 群里说普通话：不接
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const ownerStore = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog, ownerStore });
    const res = await r.handle(msg('A1', '今天开会开到吐'));
    assert.equal(res.skipped, 'owner-not-called', '实际：' + JSON.stringify(res));
    assert.equal(bot.calls.length, 0);
    assert.equal(brain.seen.length, 0, '不该为这句话调模型');
    console.log('✓ 你在群里说话但没叫它 → 不接、也不调模型');
  }

  // 2. 句子里带「水鸡」→ 接
  {
    const bot = fakeBot();
    const brain = fakeBrain('在呢');
    const ownerStore = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog, ownerStore });
    const res = await r.handle(msg('A2', '水鸡你说句话', { mentioned: true })); // qq.js 会把带名字的置 mentioned=true
    assert.equal(bot.calls.length, 1, '叫了名字应该接');
    assert.ok(res.reply || res.sent, '实际：' + JSON.stringify(res));
    console.log('✓ 你叫「水鸡」→ 它接');
  }

  // 3. 群里 @ 它 → 接
  {
    const bot = fakeBot();
    const brain = fakeBrain('咋了');
    const ownerStore = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog, ownerStore });
    await r.handle(msg('A3', '这个怎么弄', { mentioned: true }));
    assert.equal(bot.calls.length, 1);
    console.log('✓ 你 @ 它 → 它接');
  }

  // 4. 私聊 → 照常接
  {
    const bot = fakeBot();
    const brain = fakeBrain('嗯');
    const ownerStore = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog, ownerStore });
    await r.handle({ scene: 'c2c', userId: 'U_OWNER', userName: 'Alice', msgId: 'P1', content: '在吗' });
    assert.equal(bot.calls.length, 1, '私聊应该照常回');
    console.log('✓ 私聊不受影响（照常回）');
  }

  // 5. 潜水命令没叫名字也生效
  {
    const bot = fakeBot();
    const brain = fakeBrain('好');
    const ownerStore = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const modeStore = createModeStore({ log: silentLog });
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog, ownerStore, modeStore });
    const res = await r.handle(msg('A5', '潜水'));
    assert.equal(res.command, 'silent');
    assert.equal(modeStore.isSilent(), true);
    console.log('✓ 你的「潜水」命令不用叫名字也生效');
  }

  // 6. 群友点名骂它 → 直接回嘴（冷却/上限都拦不住）
  {
    const bot = fakeBot();
    const brain = fakeBrain('你才垃圾');
    const cfg = fakeCfg({
      groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 3600, maxPerHour: 1, contextSize: 6 },
    });
    const r = createResponder({ cfg, bot, brain, log: silentLog });
    const res = await r.handle(msg('B1', '水鸡你个垃圾', { userName: 'yyz', userId: 'U_YYZ' }));
    assert.equal(bot.calls.length, 1, '被骂应该回嘴，实际：' + JSON.stringify(res));
    assert.notEqual(res.skipped, 'group-cooldown');
    assert.ok(brain.seen[0].hostile.includes('垃圾'), '提示词应带上对方的脏字：' + JSON.stringify(brain.seen[0].hostile));
    console.log('✓ 群友点名骂它 → 不吃冷却，直接回嘴（带上对方的词）');
  }

  // 7. 群友 @ 它骂 → 回嘴
  {
    const bot = fakeBot();
    const brain = fakeBrain('你才有病');
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog });
    await r.handle(msg('B2', '傻逼吧你', { userName: 'yyz', userId: 'U_YYZ', mentioned: true }));
    assert.equal(bot.calls.length, 1);
    assert.ok(brain.seen[0].hostile.length > 0);
    console.log('✓ 群友 @ 它骂 → 回嘴');
  }

  // 8. 群友吐槽别的东西（没冲它）→ 不算恶意
  {
    const d = detectHostile({ text: '这游戏真垃圾', isGroup: true, mentioned: false, botNames: ['水鸡'] });
    assert.equal(d.hostile, false, '不该误伤无关吐槽');
    assert.equal(d.reason, 'not-targeted');
    console.log('✓ 「这游戏真垃圾」这种不算冲它来（不误伤）');
  }

  // 9. 「你个 XX」句式 → 算冲它来
  {
    const d = detectHostile({ text: '你个废物', isGroup: true, mentioned: false, botNames: ['水鸡'] });
    assert.equal(d.hostile, true);
    assert.equal(d.reason, 'directed');
    console.log('✓ 「你个废物」这种直指它的也算');
  }

  // 10. 关掉 hostile.enabled → 不反击
  {
    const bot = fakeBot();
    const brain = fakeBrain('嗯');
    const cfg = fakeCfg({ hostile: { enabled: false }, groupAuto: { enabled: false } });
    const r = createResponder({ cfg, bot, brain, log: silentLog });
    const res = await r.handle(msg('C1', '水鸡你个垃圾', { userName: 'yyz', userId: 'U_YYZ' }));
    assert.equal(bot.calls.length, 0, '关掉后不该回，实际：' + JSON.stringify(res));
    console.log('✓ hostile.enabled=false → 不反击');
  }

  // 11. 主人自己骂它：不算恶意，且没叫名字不接
  {
    const d = detectHostile({ text: '水鸡你个垃圾', isGroup: true, mentioned: true, botNames: ['水鸡'], fromOwner: true });
    assert.equal(d.hostile, false, '主人骂它不算恶意');
    const hits = findInsults('傻逼水鸡');
    assert.ok(hits.includes('傻逼'));
    console.log('✓ 你自己骂它不算「别人恶意」，词表也能认出来');
  }

  if (process.exitCode) console.error('\n有失败用例');
  else console.log('\n只叫名字才接 / 挨骂回嘴 测试全部通过 ✅');
})().catch((e) => { console.error('✗ 崩了:', e); process.exitCode = 1; });
