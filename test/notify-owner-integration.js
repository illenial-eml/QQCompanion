'use strict';
/**
 * 「有人找你」端到端：真的接到 responder 里，验证
 *  1) 别人点名找主人 → 发一条通知，但她照常回话（不硬编）
 *  2) 私聊里她 PASS（接不住）→ 发通知
 *  3) 主人自己说同样的话 → 不发通知
 *  4) 群里 PASS 属于「不想接话」，不当成接不住
 */
const assert = require('assert');
const { createResponder } = require('../src/responder');

let passed = 0;
const failures = [];
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function fakeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop };
}

function fakeBot() {
  return {
    async sendC2C() { return { ok: true }; },
    async sendGroup() { return { ok: true }; },
    async sendTo() { return { ok: true }; },
    async sendGroupMsg() { return { ok: true }; },
  };
}

// 注意：responder 读的是 msg.content，不是 msg.text
function mkMsg(over = {}) {
  return {
    scene: 'c2c',
    userId: 'friend1',
    userName: '小明',
    msgId: 'm1',
    content: '',
    attachments: [],
    ...over,
  };
}

const cfg = {
  qq: {
    allowFrom: [],
    allowGroups: [],
    botNames: ['水鸡', '鸿'],
    groupAuto: { passiveAfterSec: 0 },
    groupAnswer: { enabled: false },
    groupTopic: { enabled: false },
  },
  rhythm: { enabled: false },
  sticker: { enabled: false },
};

function mkNotifier(notices) {
  return {
    settings: { cooldownMinutes: 30 },
    async maybe(x) { notices.push(x); return true; },
  };
}

function mkResponder({ notices, brainReply = '好的', extra = {} }) {
  return createResponder({
    cfg,
    bot: fakeBot(),
    brain: { async chat() { return brainReply; } },
    log: fakeLog(),
    notifySvc: mkNotifier(notices),
    safeSend: async () => ({ ok: true }),
    ...extra,
  });
}

async function run() {
  console.log('\n=== 有人找你（端到端）===\n');

  await ok('别人点名找主人 → 通知一次，她照常回话', async () => {
    const notices = [];
    const r = await mkResponder({ notices, brainReply: '他不在诶' })
      .handle(mkMsg({ content: '我找火鸟', userId: 'friend1' }));
    assert.ok(notices.length >= 1, '应该发通知');
    assert.strictEqual(notices[0].kind, 'find');
    assert.ok(String(notices[0].reason).includes('火鸟'));
    assert.ok(!r.error);
  });

  await ok('主人自己说同样的话 → 不发通知', async () => {
    const notices = [];
    const r = await mkResponder({
      notices,
      brainReply: '在呢',
      extra: {
        ownerStore: {
          match: (m) => ({ owner: String(m.userId) === '3500000000', reason: 'id' }),
          names: () => [],
          learn: () => {},
          settings: { alwaysReply: false },
        },
      },
    }).handle(mkMsg({ content: '我找火鸟', userId: '3500000000' }));
    assert.strictEqual(notices.length, 0, '主人说话不该通知');
    assert.ok(!r.error);
  });

  await ok('私聊里她接不住（PASS）→ 通知', async () => {
    const notices = [];
    const r = await mkResponder({ notices, brainReply: '' })
      .handle(mkMsg({ content: '这个你怎么办', userId: 'friend2', userName: '小红' }));
    assert.ok(notices.length >= 1, '私聊 PASS 应该通知');
    assert.strictEqual(notices[0].kind, 'stuck');
    assert.ok(!r.error);
  });

  await ok('群里 PASS 不算接不住（只是不想接话）', async () => {
    const notices = [];
    const r = await mkResponder({ notices, brainReply: '' }).handle(mkMsg({
      scene: 'group',
      groupId: 'g1',
      userId: 'someone',
      userName: '路人',
      content: '今天好热啊',
      mentioned: false,
    }));
    assert.strictEqual(notices.length, 0, '群里闲聊不该通知');
    assert.ok(!r.error);
  });

  await ok('没接通知服务时一切照旧（不崩）', async () => {
    const responder = createResponder({
      cfg,
      bot: fakeBot(),
      brain: { async chat() { return '好的'; } },
      log: fakeLog(),
      safeSend: async () => ({ ok: true }),
    });
    const r = await responder.handle(mkMsg({ content: '我找火鸟' }));
    assert.ok(!r.error);
  });

  console.log(`\n通过 ${passed} 项`);
  if (failures.length) {
    console.log(`失败 ${failures.length} 项：`);
    for (const f of failures) console.log(' -', f.name, '\n', f.e.stack);
    process.exit(1);
  }
  console.log('');
}

run();
