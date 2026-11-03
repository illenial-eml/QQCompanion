'use strict';
/**
 * 群名记录 + 潜水总结私发 测试（不联网、不调模型）
 *   1) 群名清洗（去引号/句末标点）
 *   2) 群里说「群名叫 XXX」→ 记住当前群
 *   3) 私聊说「群2叫 XXX」→ 按编号找群改名
 *   4) config 种子（按 openid / 按编号）生效，且不覆盖你教过的
 *   5) 群聊日志 digest 用真群名而不是「群1」
 *   6) 群日志编号不再撞号（两个群不会都叫群1）
 *   7) responder：只有主人说「群名叫…」才当命令，群友说不当
 *   8) 潜水：群里说「浮上来」→ 群里只回一句，小结私发给主人
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGroupNames, cleanName } = require('../src/groupnames');
const { createGroupLog } = require('../src/grouplog');
const { createResponder } = require('../src/responder');
const { createOwnerStore } = require('../src/owner');
const { createModeStore } = require('../src/modes');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-gn-'));
}

function fakeCfg(over = {}) {
  return {
    qq: {
      allowFrom: [],
      allowGroups: [],
      replyInGroup: true,
      maxReplyChars: 100,
      typing: false,
      ownerIds: [],
      ownerNames: [],
      groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 0, maxPerHour: 20, contextSize: 6 },
      ...over,
    },
    rhythm: { enabled: false },
    modes: { enabled: true },
  };
}

function fakeBot() {
  const calls = [];
  return {
    calls,
    async sendC2C(id, content, opts = {}) {
      calls.push({ kind: 'c2c', id, content, ...opts });
      return { id: 'ok' };
    },
    async sendGroup(id, content, opts = {}) {
      calls.push({ kind: 'group', id, content, ...opts });
      return { id: 'ok' };
    },
    async sendTyping() { return { ok: true }; },
  };
}

const groupMsg = (id, content, over = {}) => ({
  scene: 'group', groupId: 'G1', userId: 'U1', userName: 'Alice', msgId: id, content, mentioned: false, ...over,
});

(async () => {
  // 1. 名字清洗
  {
    assert.equal(cleanName('「bio人能飞」'), 'bio人能飞');
    assert.equal(cleanName('  test 。'), 'test');
    assert.equal(cleanName('《群名》'), '群名');
    assert.equal(cleanName('这是不是一句话？'), '');
    console.log('✓ 群名清洗：去引号、去句末标点、整句问句不要');
  }

  // 2. 群里教群名
  {
    const dir = tmpdir();
    const gn = createGroupNames({ file: path.join(dir, 'names.json'), log: silentLog });
    const hit = gn.learn({ text: '群名叫 bio人能飞', groupId: 'G1', isGroup: true, labelOf: () => '群1' });
    assert.ok(hit, '没认出「群名叫 …」');
    assert.equal(hit.name, 'bio人能飞');
    assert.equal(hit.label, '群1');
    assert.equal(gn.nameOf('G1'), 'bio人能飞');
    console.log('✓ 群里说「群名叫 X」→ 记住当前群');
  }

  // 3. 私聊按编号改名
  {
    const dir = tmpdir();
    const gn = createGroupNames({ file: path.join(dir, 'names.json'), log: silentLog });
    const hit = gn.learn({
      text: '群2叫 test',
      isGroup: false,
      resolveLabel: (label) => (label === '群2' ? 'G2' : ''),
    });
    assert.ok(hit, '没认出「群2叫 …」');
    assert.equal(hit.name, 'test');
    assert.equal(gn.nameOf('G2'), 'test');
    const missing = gn.learn({ text: '群9叫 空', isGroup: false, resolveLabel: () => '' });
    assert.ok(missing && missing.missing, '不存在的群应该报 missing');
    console.log('✓ 私聊「群2叫 test」→ 按编号改名；不存在的群报 missing');
  }

  // 4. 种子 + 不覆盖你教的
  {
    const dir = tmpdir();
    const file = path.join(dir, 'names.json');
    const gn = createGroupNames({ file, log: silentLog });
    gn.set('G1', '你教的名字', { label: '群1', source: 'learn' });
    const seeded = gn.seedFromConfig({ G1: '种子名字', 群2: '种子二' }, (label) => (label === '群2' ? 'G2' : ''));
    assert.equal(gn.nameOf('G1'), '你教的名字', '种子不该覆盖学到的');
    assert.equal(gn.nameOf('G2'), '种子二');
    assert.equal(seeded, 1, '实际写入种子数应为 1（G1 被跳过）');
    console.log('✓ config 种子生效，但不覆盖你教过的群名');
  }

  // 5. 群聊日志 digest 用真群名
  {
    const dir = tmpdir();
    const log = createGroupLog({ dir, cfg: { hours: 8 }, log: silentLog });
    log.record({ groupId: 'G1', who: '小红', text: '明天食堂吃鱼吗' });
    const gn = createGroupNames({ file: path.join(dir, 'names.json'), log: silentLog });
    gn.set('G1', 'bio人能飞', { label: '群1' });
    const dg = log.digest({ hours: 8, nameOf: (gid) => gn.nameOf(gid) });
    assert.ok(dg.includes('bio人能飞'), 'digest 没用真群名：' + dg);
    assert.ok(!dg.includes('群1（'), '不该再显示编号');
    const dg2 = log.digest({ hours: 8 }); // 不给 nameOf -> 退回编号
    assert.ok(dg2.includes('群1'), '没有群名时应退回编号');
    console.log('✓ 私聊里的群聊近况用真群名（没名字才用编号）');
  }

  // 6. 群日志编号不撞号
  {
    const dir = tmpdir();
    // 模拟旧版本留下的两个都叫「群1」的文件
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'A.json'), JSON.stringify({ groupId: 'A', label: '群1', updatedAt: 1, lines: [{ who: '小明', text: '一', at: 1 }] }));
    fs.writeFileSync(path.join(dir, 'B.json'), JSON.stringify({ groupId: 'B', label: '群1', updatedAt: 2, lines: [{ who: '小红', text: '二', at: 2 }] }));
    const log = createGroupLog({ dir, cfg: {}, log: silentLog });
    log.loadAll();
    const labels = log.groups().map((g) => g.label).sort();
    assert.equal(new Set(labels).size, labels.length, '编号仍有重复：' + labels);
    assert.deepEqual(labels, ['群1', '群2']);
    // 新群应拿到群3
    log.record({ groupId: 'C', who: '小刚', text: '我也去食堂', at: 3 });
    assert.equal(log.labelOf('C'), '群3', '新群编号应接着排：' + log.labelOf('C'));
    assert.equal(log.findGroup('群3'), 'C');
    console.log('✓ 群编号不撞号（旧的重复编号会自动重排，新群接着排）');
  }

  // 7. 只有主人说「群名叫…」才算命令
  {
    const dir = tmpdir();
    const groupLog = createGroupLog({ dir: path.join(dir, 'groups'), cfg: {}, log: silentLog });
    const groupNames = createGroupNames({ file: path.join(dir, 'names.json'), log: silentLog });
    const ownerStore = createOwnerStore({ file: path.join(dir, 'owners.json'), cfg: { names: ['Alice'], ids: [] }, log: silentLog });
    const bot = fakeBot();
    const brain = { seen: [], async chat(a) { this.seen.push(a); return '在'; } };
    const r = createResponder({
      cfg: fakeCfg(), bot, brain, log: silentLog,
      groupLog, groupNames, ownerStore,
    });

    // 群友说同样的句子：不应被当成命令
    const r2 = await r.handle(groupMsg('M0', '群名叫 乱说的', { userName: 'yyz', userId: 'U_yyz' }));
    assert.notEqual(r2.command, 'group-name', '群友说「群名叫…」不该被当命令');
    assert.equal(groupNames.nameOf('G1'), '', '群友不该改群名');

    // 主人说：记下来并回一句
    const r1 = await r.handle(groupMsg('M1', '群名叫 bio人能飞'));
    assert.equal(r1.command, 'group-name');
    assert.equal(groupNames.nameOf('G1'), 'bio人能飞');
    assert.equal(bot.calls.at(-1).kind, 'group');
    assert.ok(/记下了/.test(bot.calls.at(-1).content), '没回「记下了」：' + bot.calls.at(-1).content);
    assert.equal(brain.seen.filter((s) => /群名叫/.test(s.text || '')).length, 0, '群名命令不该再调模型');
    console.log('✓ 只有主人说「群名叫…」才算命令（群友说不生效）');
  }

  // 8. 潜水：群里说「浮上来」→ 群里只回一句，小结私发给主人
  {
    const dir = tmpdir();
    const groupLog = createGroupLog({ dir: path.join(dir, 'groups'), cfg: { hours: 8 }, log: silentLog });
    groupLog.record({ groupId: 'G1', who: '小红', text: '明天十一点半食堂集合' });
    const groupNames = createGroupNames({ file: path.join(dir, 'names.json'), log: silentLog });
    groupNames.set('G1', 'bio人能飞', { label: '群1' });
    const modeStore = createModeStore({ file: path.join(dir, 'state.json'), cfg: { summarize: true, summarizeOnWake: true }, log: silentLog });
    modeStore.set(true, { by: 'Alice' });
    const ownerStore = createOwnerStore({ file: path.join(dir, 'owners.json'), cfg: { names: ['Alice'] }, log: silentLog });
    const bot = fakeBot();
    const brain = {
      seen: [],
      async chat(a) { this.seen.push(a); return '在'; },
      async summarizeGroupDigest({ digest }) {
        assert.ok(digest.includes('bio人能飞'), '小结输入应含真群名');
        return '群1（bio人能飞）约十一点半食堂集合。';
      },
    };
    const cfg = fakeCfg({ ownerIds: ['OWNER_OPENID'] });
    const r = createResponder({ cfg, bot, brain, log: silentLog, groupLog, groupNames, ownerStore, modeStore });

    const res = await r.handle(groupMsg('M1', '浮上来'));
    assert.equal(res.command, 'wake');
    const groupCalls = bot.calls.filter((c) => c.kind === 'group');
    const c2cCalls = bot.calls.filter((c) => c.kind === 'c2c');
    assert.equal(groupCalls.length, 1, '群里只该回一句，实际：' + JSON.stringify(groupCalls));
    assert.equal(groupCalls[0].content, '醒了。');
    assert.equal(c2cCalls.length, 1, '小结应私发 1 条，实际：' + JSON.stringify(c2cCalls));
    assert.equal(c2cCalls[0].id, 'OWNER_OPENID');
    assert.ok(c2cCalls[0].content.includes('食堂'), '私发内容不对：' + c2cCalls[0].content);
    assert.equal(bot.calls.filter((c) => c.kind === 'group' && /食堂/.test(c.content)).length, 0, '小结不该出现在群里');
    console.log('✓ 潜水被叫醒：群聊只回「醒了」，小结私发给主人');
  }

  if (process.exitCode) console.error('\n有失败用例');
  else console.log('\n群名 / 潜水私发 测试全部通过 ✅');
})().catch((e) => { console.error('✗ 崩了:', e); process.exitCode = 1; });
