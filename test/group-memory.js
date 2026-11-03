'use strict';
/**
 * 群聊记忆测试（不联网、不调模型）
 *   1. 只记有内容的文字（纯表情 / 「嗯」这种不记）
 *   2. 每个群一份文件，重启后能读回来
 *   3. 私聊提示词里带「群里最近在聊什么」，群聊提示词里不带
 *   4. 关掉 injectInPrivate 就不带
 *   5. responder 把群消息和它自己的回复都记进群聊日志
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGroupLog } = require('../src/grouplog');
const { Brain } = require('../src/brain');
const { MemoryStore } = require('../src/memory');
const { createResponder } = require('../src/responder');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-grouplog-'));

function newLog(extra = {}) {
  return createGroupLog({ dir: path.join(tmpRoot, 'groups'), log: silentLog, ...extra });
}

(async () => {
  // 1. 过滤没信息量的东西
  {
    const gl = newLog();
    assert.equal(gl.record({ groupId: 'G1', who: '小红', text: '今天食堂有红烧肉' }), true);
    assert.equal(gl.record({ groupId: 'G1', who: '小红', text: '[表情]' }), false, '纯表情不记');
    assert.equal(gl.record({ groupId: 'G1', who: '小红', text: '嗯' }), false, '一个字的语气词不记');
    assert.equal(gl.record({ groupId: 'G1', who: '小红', text: '' }), false, '空消息不记');
    assert.equal(gl.groups()[0].count, 1);
    gl.flush();
    console.log('✓ 只记有内容的文字');
  }

  // 2. 一个群一个文件，重启后能读回来
  {
    const dir = path.join(tmpRoot, 'groups2');
    const a = createGroupLog({ dir, log: silentLog });
    a.record({ groupId: 'GROUP_A', who: '小红', text: '有人在吗' });
    a.record({ groupId: 'GROUP_A', who: '我', text: '我在呢' });
    a.record({ groupId: 'GROUP_B', who: '小刚', text: '下班了' });
    a.flush();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 2, '两个群两个文件');

    const b = createGroupLog({ dir, log: silentLog });
    b.record({ groupId: 'GROUP_A', who: '小红', text: '还在吗' });  // 触发 load
    const g = b.groups().find((x) => x.groupId === 'GROUP_A');
    assert.equal(g.count, 3, '读回来 2 条 + 新记 1 条');
    assert.match(g.label, /^群\d+$/, '群有个人类可读的编号');
    const dg = b.digest({ hours: 24 });
    assert.ok(dg.includes('## 群里最近在聊什么'));
    assert.ok(dg.includes('小红：有人在吗'));
    assert.ok(dg.includes('我：我在呢'), '它自己说过的话写成「我：」');
    console.log('✓ 每个群一份文件、重启能读回、标签是人类可读的编号');
  }

  // 3. 时间窗口与条数上限
  {
    const gl = newLog();
    const now = Date.now();
    for (let i = 0; i < 5; i++) gl.record({ groupId: 'G9', who: '小明', text: `第${i}句`, at: now });
    gl.record({ groupId: 'G9', who: '小明', text: '很久以前的话', at: now - 30 * 3600 * 1000 });
    const dg = gl.digest({ hours: 8, perGroup: 2 });
    assert.ok(!dg.includes('很久以前的话'), '超过时间窗口的不带');
    assert.ok(dg.includes('第4句') && dg.includes('第3句'), '只带最近 2 条');
    assert.ok(!dg.includes('第2句'));
    console.log('✓ 时间窗口 + 每个群条数上限');
  }

  // 4. 单群最多存 maxLines 条
  {
    const gl = createGroupLog({ dir: path.join(tmpRoot, 'groups3'), log: silentLog, cfg: { maxLines: 3 } });
    for (let i = 0; i < 6; i++) gl.record({ groupId: 'GX', who: '小明', text: `消息${i}` });
    assert.equal(gl.groups()[0].count, 3, '只留最后 3 条');
    console.log('✓ 单个群最多存 maxLines 条（先进先出）');
  }

  // 5. 私聊提示词带群聊近况，群聊提示词不带
  {
    const gl = newLog();
    gl.record({ groupId: 'GROUP_A', who: '小红', text: '明天食堂吃鱼吗' });
    const cfg = {
      qq: { botNames: ['水鸡'], groupLog: { injectInPrivate: true, hours: 8 } },
      style: { enabled: false }, sticker: { enabled: false }, memory: { maxTurns: 6 },
      paths: { data: tmpRoot, persona: path.join(__dirname, '..', 'src', 'persona.md') },
      brain: { model: 'x', apiKey: 'k' },
    };
    const brain = new Brain(cfg, { log: silentLog, groupLog: gl });
    const c2c = brain.systemPrompt({ turns: [] }, { scene: 'c2c' });
    assert.ok(c2c.includes('## 群里最近在聊什么'), '私聊里应该能看到群里的事');
    assert.ok(c2c.includes('小红：明天食堂吃鱼吗'));
    const group = brain.systemPrompt({ turns: [] }, { scene: 'group', groupContext: '小红：随便聊聊' });
    assert.ok(!group.includes('## 群里最近在聊什么'), '群里不用再重复带');

    cfg.qq.groupLog.injectInPrivate = false;
    const off = brain.systemPrompt({ turns: [] }, { scene: 'c2c' });
    assert.ok(!off.includes('## 群里最近在聊什么'), '关掉就不带');
    console.log('✓ 私聊提示词带群聊近况，群聊 / 关掉时都不带');
  }

  // 6. responder 把群消息和它的回复都记进日志
  {
    const gl = newLog();
    const bot = { calls: [], async sendGroup(id, content) { this.calls.push({ id, content }); return { id: 'ok' }; }, async sendC2C() { return { id: 'ok' }; }, async sendTyping() { return { ok: true }; } };
    const brain = { async chat() { return '那就吃鱼'; } };
    const r = createResponder({
      cfg: {
        qq: {
          allowFrom: [], allowGroups: [], replyInGroup: true, maxReplyChars: 100, typing: false,
          groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 0, maxPerHour: 20, contextSize: 4 },
        },
        rhythm: { enabled: false }, sticker: { enabled: false },
      },
      bot, brain, log: silentLog, groupLog: gl,
    });
    await r.handle({ scene: 'group', groupId: 'GROUP_Z', userId: 'U1', userName: '小红', msgId: 'M1', content: '今晚吃鱼吗', mentioned: true });
    const g = gl.groups().find((x) => x.groupId === 'GROUP_Z');
    assert.ok(g, '应该建了这个群的日志');
    const dg = gl.digest({ hours: 24 });
    assert.ok(dg.includes('小红：今晚吃鱼吗'), '记下了别人说的话');
    assert.ok(dg.includes('我：那就吃鱼'), '也记下它自己的回复');
    console.log('✓ responder 把群消息和回复都记进群聊日志');
  }

  // 7. 没有数据时不出空段落
  {
    const gl = createGroupLog({ dir: path.join(tmpRoot, 'empty'), log: silentLog });
    assert.equal(gl.digest({ hours: 8 }), '', '没数据就返回空字符串');
    console.log('✓ 没数据时不出空段落');
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('\n群聊记忆测试全部通过 ✅');
})().catch((e) => { console.error('✗ 测试失败:', e.message); process.exit(1); });

