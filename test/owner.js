'use strict';
/**
 * 「认主人 + 听主人的话」测试（不联网、不调模型）：
 *   1. 按昵称认人（大小写/空格不敏感）
 *   2. 按 openid 认人（私聊最稳）
 *   3. 群昵称认到之后，把该群的 member_openid 记进 data/owners.json，重启仍然认
 *   4. 主人在群里说话：没 @、冷却中、内容是「嗯」这种杂音 —— 照样接
 *   5. 非主人的同类消息：该跳过的还是跳过
 *   6. 提示词：主人的消息带「## 他本人在跟你说话」，别人不带
 *   7. ownerAlwaysReply=false 时可以退回普通群聊规则
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createResponder } = require('../src/responder');
const { Brain } = require('../src/brain');
const { createOwnerStore } = require('../src/owner');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-owner-'));

function fakeCfg(qq = {}, brainCfg = {}) {
  return {
    root: path.join(__dirname, '..'),
    paths: {
      data: tmpDir,
      memory: path.join(tmpDir, 'memory'),
      persona: path.join(__dirname, '..', 'src', 'persona.md'),
    },
    qq: {
      allowFrom: [],
      allowGroups: [],
      replyInGroup: true,
      maxReplyChars: 100,
      typing: false,
      botNames: ['水鸡'],
      groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 0, maxPerHour: 20, contextSize: 6 },
      ...qq,
    },
    rhythm: { enabled: false },
    brain: { model: 'x', maxTokens: 100, temperature: 0.5, thinking: 'disabled', ...brainCfg },
    memory: { enabled: false, maxTurns: 10, maxChars: 1000 },
    sticker: { enabled: false },
    style: { enabled: false },
  };
}

function fakeBot() {
  const calls = [];
  return {
    calls,
    async sendC2C(id, content, { msgId }) { calls.push({ kind: 'c2c', id, content, msgId }); return { id: 'ok' }; },
    async sendGroup(id, content, { msgId }) { calls.push({ kind: 'group', id, content, msgId }); return { id: 'ok' }; },
    async sendTyping() { return { ok: true }; },
  };
}

function fakeBrain({ pass = false, reply = '行' } = {}) {
  const seen = [];
  return {
    seen,
    async chat(args) { seen.push(args); return pass ? '' : reply; },
  };
}

const groupMsg = (id, content, over = {}) => ({
  scene: 'group', groupId: 'G1', userId: 'U_' + id, userName: '小明', msgId: id, content, mentioned: false, ...over,
});

(async () => {
  // 1. 按昵称认人
  {
    const store = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    assert.equal(store.match({ scene: 'group', userName: 'Alice', userId: 'X1' }).owner, true);
    assert.equal(store.match({ scene: 'group', userName: 'alice', userId: 'X2' }).owner, true, '大小写不敏感');
    assert.equal(store.match({ scene: 'group', userName: '  Alice ', userId: 'X3' }).owner, true, '两侧空格');
    assert.equal(store.match({ scene: 'group', userName: 'yyz', userId: 'X4' }).owner, false);
    console.log('✓ 按昵称认人（大小写、空格不敏感）');
  }

  // 1b. 昵称别名（换昵称也认得出来：eml / 火鸡 / 火鸟…）
  {
    const aliases = ['eml', '火鸡', '火鸟', '火鸡的大肥鱼'];
    const store = createOwnerStore({ cfg: { names: ['Alice'], aliases }, log: silentLog });
    for (const n of ['Alice', 'eml', 'EML', 'E.M.L', '火鸡', '火鸟']) {
      assert.equal(store.match({ scene: 'group', userName: n, userId: 'A_' + n }).owner, true, `${n} 应该认成主人`);
    }
    assert.equal(store.match({ scene: 'group', userName: '水鸡', userId: 'B1' }).owner, false, '水鸡是它自己');
    assert.equal(store.match({ scene: 'group', userName: '路人甲', userId: 'B2' }).owner, false);
    const hit = store.match({ scene: 'group', userName: 'eml_小号', userId: 'B3' });
    assert.equal(hit.reason, 'alias');
    // 别名认出来也会自动记住这个群里的 id
    const file = path.join(tmpDir, 'owners-alias.json');
    const s2 = createOwnerStore({ file, cfg: { aliases: ['火鸡'] }, log: silentLog });
    const m = { scene: 'group', groupId: 'G9', userName: '火鸡本鸡', userId: 'MEMBER_9' };
    assert.equal(s2.match(m).reason, 'alias');
    assert.equal(s2.learn(m), true);
    const s3 = createOwnerStore({ file, cfg: { aliases: ['火鸡'] }, log: silentLog });
    assert.equal(s3.match({ scene: 'group', userName: '换了名字', userId: 'MEMBER_9' }).reason, 'id', '记住 id 后不再依赖昵称');
    console.log('✓ 昵称别名认人（eml / 火鸡 / 火鸟，换昵称也认得）');
  }

  // 2. 按 openid 认人（私聊）
  {
    const store = createOwnerStore({ cfg: { ids: ['A96CFBBC1C6382B670B80E03A1EDD71E'] }, log: silentLog });
    assert.equal(store.match({ scene: 'c2c', userId: 'A96CFBBC1C6382B670B80E03A1EDD71E', userName: '谁' }).owner, true);
    assert.equal(store.match({ scene: 'c2c', userId: 'OTHER' }).owner, false);
    console.log('✓ 按 openid 认人');
  }

  // 3. 群昵称认到之后自动记住 member_openid，重启仍认
  {
    const file = path.join(tmpDir, 'owners-learn.json');
    const a = createOwnerStore({ file, cfg: { names: ['Alice'] }, log: silentLog });
    const msg = { scene: 'group', groupId: 'G1', userName: 'Alice', userId: 'MEMBER_OPENID_1' };
    assert.equal(a.match(msg).reason, 'name');
    assert.equal(a.learn(msg), true, '第一次应该记住');
    assert.equal(a.learn(msg), false, '重复不重复记');
    assert.ok(fs.existsSync(file), '要落盘');
    const b = createOwnerStore({ file, cfg: { names: [] }, log: silentLog });
    assert.equal(b.match({ scene: 'group', userName: '路人', userId: 'MEMBER_OPENID_1' }).owner, true, '重启后按 id 也认');
    assert.equal(b.learn({ scene: 'group', userId: 'MEMBER_OPENID_2', userName: 'Alice' }), true, '第二个群也能学');
    console.log('✓ 群昵称认到后自动记住 member_openid（重启有效、每个群单独学）');
  }

  // 4. 主人在群里说话：默认不接（要叫它名字 / @ 它）
  {
    const bot = fakeBot();
    const brain = fakeBrain({ reply: '行，听你的' });
    const owner = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const cfg = fakeCfg({ groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 3600, maxPerHour: 20, contextSize: 6 } });
    const r = createResponder({ cfg, bot, brain, log: silentLog, ownerStore: owner });
    const quiet = await r.handle(groupMsg('O0', '今天开会开到吐', { userName: 'Alice' }));
    assert.equal(quiet.skipped, 'owner-not-called', '没叫它就别接');
    assert.equal(brain.seen.length, 0, '没叫它不该调模型');
    const res = await r.handle(groupMsg('O1', '水鸡你复述一句：我不吃饭', { userName: 'Alice', mentioned: true }));
    assert.equal(brain.seen.length, 1, '叫了名字要真的调模型');
    assert.equal(brain.seen[0].fromOwner, true, '要告诉模型这是主人');
    assert.equal(brain.seen[0].allowPass, false, '主人说话不许 PASS');
    assert.ok(bot.calls.length >= 1, '要回出来');
    assert.equal(res.skipped, undefined, '不能被跳过');
    console.log('✓ 主人在群里说话：没叫名字不接；叫了「水鸡」就接（冷却 1 小时也不管）');
  }

  // 4b. 主人发「嗯」这种杂音：叫了名字也接（不被 trivial 拦掉）
  {
    const bot = fakeBot();
    const brain = fakeBrain({ reply: '嗯？' });
    const owner = createOwnerStore({ cfg: { ids: ['OWNER_ID'] }, log: silentLog });
    const cfg = fakeCfg();
    const r = createResponder({ cfg, bot, brain, log: silentLog, ownerStore: owner });
    await r.handle(groupMsg('O2', '嗯', { userId: 'OWNER_ID', userName: '谁', mentioned: true }));
    assert.equal(brain.seen.length, 1, '被 @ 时主人的「嗯」也要接');
    console.log('✓ 主人被 @ 时发「嗯」也接（不会被当杂音丢掉）');
  }

  // 5. 非主人：该跳过还是跳过
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const owner = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const cfg = fakeCfg({ groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 3600, maxPerHour: 20, contextSize: 6, passiveAfterSec: 0 } });
    const r = createResponder({ cfg, bot, brain, log: silentLog, ownerStore: owner });
    const first = await r.handle(groupMsg('N1', '今天天气不错', { userName: '路人甲' }));
    assert.equal(first.skipped, undefined, '第一条不在冷却里，正常接');
    await new Promise((s) => setTimeout(s, 1100));
    const res = await r.handle(groupMsg('N2', '确实不错', { userName: '路人甲二' }));
    assert.ok(['group-cooldown', 'group-busy'].includes(res.skipped), '第二条进冷却');
    assert.equal(brain.seen.length, 1);
    console.log('✓ 别人说话仍走冷却（不会一视同仁）');
  }

  // 6. 提示词：主人的消息才带「他本人在跟你说话」
  {
    const brain = new Brain(fakeCfg({ ownerNames: ['Alice'] }), { log: silentLog, stickers: [] });
    const mem = { name: 'Alice', notes: [], turns: [] };
    const withOwner = brain.systemPrompt(mem, { scene: 'group', fromOwner: true });
    const without = brain.systemPrompt(mem, { scene: 'group', fromOwner: false });
    assert.ok(withOwner.includes('## 他本人在跟你说话'), '主人的消息要有命令段');
    assert.ok(withOwner.includes('别反驳'), '要明确写不反驳');
    assert.ok(!without.includes('## 他本人在跟你说话'), '别人不该有');
    console.log('✓ 提示词：只有主人的消息带「听命令、不反驳」');
  }

  // 7. 明确打开 ownerAlwaysReply=true：主人说话一律接（旧行为，可选）
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const owner = createOwnerStore({ cfg: { names: ['Alice'], alwaysReply: true }, log: silentLog });
    const cfg = fakeCfg({ groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 3600, maxPerHour: 20, contextSize: 6 } });
    const r = createResponder({ cfg, bot, brain, log: silentLog, ownerStore: owner });
    const first = await r.handle(groupMsg('O3', '今天天气不错', { userName: 'Alice' }));
    assert.equal(first.skipped, undefined, '打开开关后第一条正常接（即使冷却 1 小时）');
    assert.equal(brain.seen.length, 1);
    console.log('✓ ownerAlwaysReply=true 时主人说话一律接（可选开关）');
  }

  // 8. 默认（ownerAlwaysReply 不设）：主人没叫名字就不接
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const owner = createOwnerStore({ cfg: { names: ['Alice'] }, log: silentLog });
    const cfg = fakeCfg();
    const r = createResponder({ cfg, bot, brain, log: silentLog, ownerStore: owner });
    const res = await r.handle(groupMsg('O4', '你今天歇着吧', { userName: 'Alice' }));
    assert.equal(res.skipped, 'owner-not-called', '默认要叫它名字');
    assert.equal(brain.seen.length, 0);
    console.log('✓ 默认不设 ownerAlwaysReply：主人不叫名字就不接');
  }

  // 8. 关闭认人：谁都不算主人
  {
    const store = createOwnerStore({ cfg: { enabled: false, names: ['Alice'] }, log: silentLog });
    assert.equal(store.match({ scene: 'group', userName: 'Alice', userId: 'A' }).owner, false);
    console.log('✓ 关掉 enabled 后不再认人');
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n认主人测试全部通过 ✅');
})().catch((e) => {
  console.error('✗ 测试失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
