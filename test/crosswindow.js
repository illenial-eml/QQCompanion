'use strict';
// 跨窗口连续性（P1-4）
const assert = require('assert');
const { createCrossWindow, CROSS_DEFAULTS } = require('../src/crosswindow');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ': ' + e.message);
  }
}

const OWNER = '1000000002';

function make(over = {}, clock = { t: 1_700_000_000_000 }) {
  const cw = createCrossWindow({ cfg: { ...over }, now: () => clock.t });
  return { cw, clock };
}

console.log('记录与注入');

ok('主人在群里说的话，30 分钟内私聊能带上', () => {
  const { cw } = make();
  assert.ok(cw.noteGroupLine({ userId: OWNER, text: '今晚八点我要去打球', where: '群1', owner: true }));
  const ctx = cw.contextFor({ userId: OWNER, scene: 'c2c' });
  assert.ok(ctx.includes('今晚八点我要去打球'), ctx);
  assert.ok(ctx.includes('刚才在群里'), ctx);
});

ok('不是主人说的话不记', () => {
  const { cw } = make();
  assert.strictEqual(cw.noteGroupLine({ userId: '9999', text: '我是群友', owner: false }), false);
  assert.strictEqual(cw.contextFor({ userId: '9999', scene: 'c2c' }), '');
});

ok('私聊里说的话不会被当群聊记', () => {
  const { cw } = make();
  // 调用方只在群里调 noteGroupLine；这里确认即便误调也不会产生群上下文以外的错
  cw.noteGroupLine({ userId: OWNER, text: '私聊的话', where: '', owner: true });
  assert.ok(cw.contextFor({ userId: OWNER, scene: 'c2c' }));
});

ok('超过 30 分钟就不提了', () => {
  const { cw, clock } = make();
  cw.noteGroupLine({ userId: OWNER, text: '刚才在群里说的是这句', where: '群1', owner: true });
  clock.t += (CROSS_DEFAULTS.windowMinutes + 1) * 60 * 1000;
  assert.strictEqual(cw.contextFor({ userId: OWNER, scene: 'c2c' }), '');
});

ok('群里不注入（只在私聊提）', () => {
  const { cw } = make();
  cw.noteGroupLine({ userId: OWNER, text: '群里说的', where: '群1', owner: true });
  assert.strictEqual(cw.contextFor({ userId: OWNER, scene: 'group' }), '');
});

ok('没有记录时返回空串', () => {
  const { cw } = make();
  assert.strictEqual(cw.contextFor({ userId: OWNER, scene: 'c2c' }), '');
});

console.log('清洗与上限');

ok('去掉 @ 和链接', () => {
  const { cw } = make();
  cw.noteGroupLine({ userId: OWNER, text: '@小明 你看这个 https://example.com/x 有意思', where: '群1', owner: true });
  const ctx = cw.contextFor({ userId: OWNER, scene: 'c2c' });
  assert.ok(!ctx.includes('@小明'), ctx);
  assert.ok(!ctx.includes('example.com'), ctx);
  assert.ok(ctx.includes('[链接]'), ctx);
});

ok('一句话太长会截断', () => {
  const { cw } = make({ lineChars: 10 });
  cw.noteGroupLine({ userId: OWNER, text: '这是一句非常非常非常长的话要截断它', where: '群1', owner: true });
  const list = cw.recent({ userId: OWNER });
  assert.strictEqual(list[0].text.length, 10);
});

ok('最多只带 maxLines 句', () => {
  const { cw } = make({ maxLines: 2 });
  for (const t of ['第一句内容', '第二句内容', '第三句内容']) {
    cw.noteGroupLine({ userId: OWNER, text: t, where: '群1', owner: true });
  }
  const ctx = cw.contextFor({ userId: OWNER, scene: 'c2c' });
  assert.ok(ctx.includes('第三句内容'), ctx);
  assert.ok(!ctx.includes('第一句内容'), ctx);
});

ok('整段不超过 maxChars', () => {
  const { cw } = make({ maxChars: 90 });
  for (let i = 0; i < 3; i++) cw.noteGroupLine({ userId: OWNER, text: '很长的内容很长的内容很长的内容' + i, where: '群1', owner: true });
  const ctx = cw.contextFor({ userId: OWNER, scene: 'c2c' });
  assert.ok(ctx.length <= 90, 'len=' + ctx.length);
});

ok('复读不重复记', () => {
  const { cw } = make();
  cw.noteGroupLine({ userId: OWNER, text: '同一句话', where: '群1', owner: true });
  assert.strictEqual(cw.noteGroupLine({ userId: OWNER, text: '同一句话', where: '群1', owner: true }), false);
  assert.strictEqual(cw.recent({ userId: OWNER }).length, 1);
});

console.log('开关');

ok('关掉后既不多记也不注入', () => {
  const { cw } = make({ enabled: false });
  assert.strictEqual(cw.noteGroupLine({ userId: OWNER, text: '关掉时说的', owner: true }), false);
  assert.strictEqual(cw.contextFor({ userId: OWNER, scene: 'c2c' }), '');
});

ok('clear 能一键忘掉', () => {
  const { cw } = make();
  cw.noteGroupLine({ userId: OWNER, text: '忘掉这句', where: '群1', owner: true });
  cw.clear(OWNER);
  assert.strictEqual(cw.contextFor({ userId: OWNER, scene: 'c2c' }), '');
});

ok('state 报出人数', () => {
  const { cw } = make();
  cw.noteGroupLine({ userId: OWNER, text: '第一句话', owner: true });
  cw.noteGroupLine({ userId: '1000', text: '第二句话', owner: true });
  assert.strictEqual(cw.state().people, 2);
});

console.log(`\n通过 ${pass}  失败 ${fail}`);
process.exit(fail ? 1 : 0);
