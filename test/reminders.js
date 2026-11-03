'use strict';
/** 日程提醒：解析 + 增删 + 到点发送重试。node test/reminders.js */

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  parseReminder, fmt, fmtIn, createReminderStore, isReminderRequest,
} = require('../src/reminders');

// 固定「现在」：北京时间 2026-10-27 22:00（周二）
const NOW = Date.UTC(2026, 9, 27, 14, 0, 0, 0);

function at(text, now = NOW) {
  const r = parseReminder(text, now);
  return r ? { when: fmt(r.at), body: r.body, ms: r.at } : null;
}

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
}
function okAsync(name, fn) {
  return fn().then(() => { pass++; console.log(`  ✓ ${name}`); });
}

function tmpFile() {
  return path.join(os.tmpdir(), `reminders-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

console.log('日程提醒解析');

ok('明天早上9点提醒我开会', () => {
  const r = at('明天早上9点提醒我开会');
  assert.ok(r, '应该解析出来');
  assert.strictEqual(r.when, '10月28日 周三 09:00');
  assert.strictEqual(r.body, '开会');
});

ok('30分钟后提醒我喝水', () => {
  const r = at('30分钟后提醒我喝水');
  assert.strictEqual(r.ms, NOW + 30 * 60000);
  assert.strictEqual(r.body, '喝水');
});

ok('半小时后提醒我关火', () => {
  const r = at('半小时后提醒我关火');
  assert.strictEqual(r.ms, NOW + 30 * 60000);
  assert.strictEqual(r.body, '关火');
});

ok('今晚11点提醒我睡觉', () => {
  const r = at('今晚11点提醒我睡觉');
  assert.strictEqual(r.when, '10月27日 周二 23:00');
  assert.strictEqual(r.body, '睡觉');
});

ok('两小时后提醒我收快递', () => {
  const r = at('两小时后提醒我收快递');
  assert.strictEqual(r.ms, NOW + 2 * 3600000);
});

ok('下午3点提醒我给妈妈打电话（今天已过 → 顺延明天）', () => {
  const r = at('下午3点提醒我给妈妈打电话');
  assert.strictEqual(r.when, '10月28日 周三 15:00');
  assert.strictEqual(r.body, '给妈妈打电话');
});

ok('中文分钟数：下午3点二十五 → 15:25（不能变成 3:15）', () => {
  const r = at('下午3点二十五提醒我吃东西');
  assert.strictEqual(r.when, '10月28日 周三 15:25');
  assert.strictEqual(r.body, '吃东西');
});

ok('中文数字各档都对：九 / 十二 / 十 / 二十五', () => {
  assert.strictEqual(at('明天九点提醒我').when, '10月28日 周三 09:00');
  assert.strictEqual(at('明天十二点提醒我').when, '10月28日 周三 12:00');
  assert.strictEqual(at('明天十点提醒我').when, '10月28日 周三 10:00');
  assert.strictEqual(at('明天下午两点二十五提醒我').when, '10月28日 周三 14:25');
});

ok('明早七点半提醒我吃药', () => {
  const r = at('明早七点半提醒我吃药');
  assert.strictEqual(r.when, '10月28日 周三 07:30');
  assert.strictEqual(r.body, '吃药');
});

ok('中午12点提醒我吃饭', () => {
  const r = at('中午12点提醒我吃饭');
  assert.strictEqual(r.when, '10月28日 周三 12:00');
});

ok('中午11:40 就是 11:40，不是 23:40（中午不能一律 +12）', () => {
  const r = at('明天中午11: 40提醒我开会');
  assert.strictEqual(r.when, '10月28日 周三 11:40');
  assert.strictEqual(r.body, '开会');
});

ok('中午1点 → 13:00，中午12点 → 12:00', () => {
  assert.strictEqual(at('明天中午1点提醒我吃饭').when, '10月28日 周三 13:00');
  assert.strictEqual(at('明天中午12点提醒我吃饭').when, '10月28日 周三 12:00');
});

ok('冒号前后有空格也能认（9 : 30 / 11: 40）', () => {
  assert.strictEqual(at('明天9 : 30提醒我开会').when, '10月28日 周三 09:30');
  assert.strictEqual(at('明天11: 40提醒我开会').body, '开会');
});

ok('这周五下午3点提醒我交报告（周五=10/30）', () => {
  const r = at('这周五下午3点提醒我交报告');
  assert.strictEqual(r.when, '10月30日 周五 15:00');
  assert.strictEqual(r.body, '交报告');
});

ok('下周一9点提醒我开会（下周一=11/2）', () => {
  assert.strictEqual(at('下周一9点提醒我开会').when, '11月2日 周一 09:00');
});

ok('具体日期：10月30日9点提醒我交作业', () => {
  assert.strictEqual(at('10月30日9点提醒我交作业').when, '10月30日 周五 09:00');
});

ok('只说日期不说时间 → 默认 9 点', () => {
  assert.strictEqual(at('后天提醒我拿快递').when, '10月29日 周四 09:00');
});

console.log('\n不该记成日程的（乱加防护）');

ok('闲聊里提到「提醒」但没有请求语气 → 不记', () => {
  assert.strictEqual(parseReminder('我明天9点得提醒他去开会', NOW), null);
  assert.strictEqual(parseReminder('他提醒说明天开会', NOW), null);
  assert.strictEqual(parseReminder('明天9点提醒吗？', NOW), null);
  assert.strictEqual(parseReminder('你要不要提醒我一下', NOW), null);
});

ok('纯提问不带时间 → 不记', () => {
  assert.strictEqual(parseReminder('明天早上9点开会吗？', NOW), null);
  assert.strictEqual(parseReminder('明天要考试', NOW), null);
});

ok('「记得」这种词单独出现不触发', () => {
  assert.strictEqual(parseReminder('我记得明天有个会', NOW), null);
});

ok('过长的闲聊不当日程', () => {
  const long = '今天好累啊'.repeat(30) + '明天9点提醒我';
  assert.strictEqual(parseReminder(long, NOW), null);
});

ok('isReminderRequest 的判定', () => {
  assert.strictEqual(isReminderRequest('提醒我明天9点开会'), true);
  assert.strictEqual(isReminderRequest('帮我定个明天9点的提醒'), true);
  assert.strictEqual(isReminderRequest('明天9点提醒吗？'), false);
  assert.strictEqual(isReminderRequest('我明天9点得提醒他'), false);
});

ok('过去的相对时间不认', () => {
  assert.strictEqual(parseReminder('0分钟后提醒我', NOW), null);
});

ok('fmtIn 相对描述', () => {
  assert.strictEqual(fmtIn(NOW + 30 * 60000, NOW), '30 分钟后');
  assert.strictEqual(fmtIn(NOW + 2 * 3600000, NOW), '2 小时后');
  assert.strictEqual(fmtIn(NOW + 90 * 60000, NOW), '1 小时 30 分钟后');
  assert.strictEqual(fmtIn(NOW + 3 * 86400000, NOW), '3 天后');
});

console.log('\n增删管理');

ok('add / listPending / 按编号删 / 按关键词删 / 清空', () => {
  const file = tmpFile();
  const st = createReminderStore({ file, log: null });
  const a = st.add({ at: NOW + 3600000, body: '开会', human: fmt(NOW + 3600000) });
  st.add({ at: NOW + 7200000, body: '拿快递', human: fmt(NOW + 7200000) });
  st.add({ at: NOW + 10800000, body: '给妈妈打电话', human: fmt(NOW + 10800000) });
  assert.strictEqual(st.listPending().length, 3);

  const byIdx = st.cancelByIndex(2);
  assert.ok(byIdx && byIdx.body === '拿快递', '按编号应删掉拿快递');
  assert.strictEqual(st.listPending().length, 2);

  const byKw = st.cancelByKeyword('妈妈');
  assert.ok(byKw && byKw.body === '给妈妈打电话');
  assert.strictEqual(st.listPending().length, 1);
  assert.strictEqual(st.listPending()[0].id, a.item.id);

  st.add({ at: NOW + 9000000, body: '喝水', human: fmt(NOW + 9000000) });
  assert.strictEqual(st.listPending().length, 2);
  const cleared = st.cancelAll();
  assert.strictEqual(cleared.length, 2);
  assert.strictEqual(st.listPending().length, 0);

  assert.ok(fs.existsSync(file));
  fs.unlinkSync(file);
});

ok('落盘后重新加载还在', () => {
  const file = tmpFile();
  const st1 = createReminderStore({ file, log: null });
  st1.add({ at: NOW + 3600000, body: '交作业', human: fmt(NOW + 3600000) });
  const st2 = createReminderStore({ file, log: null });
  assert.strictEqual(st2.listPending().length, 1);
  assert.strictEqual(st2.listPending()[0].body, '交作业');
  fs.unlinkSync(file);
});

ok('超过 lateGraceHours 的旧提醒不再补发，会被标完成', () => {
  const file = tmpFile();
  const st = createReminderStore({ file, log: null });
  const added = st.add({ at: NOW - 20 * 3600000, body: '很旧的', human: fmt(NOW - 20 * 3600000) });
  assert.strictEqual(st.due(NOW).length, 0, '20 小时前的不该再发');
  const n = st.expireStale(NOW);
  assert.strictEqual(n, 1);
  assert.strictEqual(st.listPending().length, 0);
  assert.ok(added.item.id > 0);
  fs.unlinkSync(file);
});

async function main() {
  console.log('\n到点发送');

  await okAsync('发送成功 → 标记完成，不会重复发', async () => {
    const file = tmpFile();
    const st = createReminderStore({ file, log: null, cfg: { tickMs: 10 } });
    const T = Date.now();
    st.add({ at: T + 5, body: '该喝水了', human: fmt(T + 5) });
    const sent = [];
    st.start({ onDue: async (it) => { sent.push(it.body); return true; } });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepStrictEqual(sent, ['该喝水了']);
    assert.strictEqual(st.listPending().length, 0);
    fs.unlinkSync(file);
  });

  await okAsync('发送失败 → 不标记完成，下一轮重试', async () => {
    const file = tmpFile();
    const st = createReminderStore({ file, log: null, cfg: { tickMs: 10 } });
    const T = Date.now();
    st.add({ at: T + 5, body: '该吃药了', human: fmt(T + 5) });
    let calls = 0;
    st.start({ onDue: async () => { calls += 1; return calls >= 3; } });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(calls >= 3, `应该重试到成功，实际 ${calls} 次`);
    assert.strictEqual(st.listPending().length, 0);
    fs.unlinkSync(file);
  });

  await okAsync('重试次数超上限 → 放弃并标记完成（不会永久卡住）', async () => {
    const file = tmpFile();
    const st = createReminderStore({ file, log: null, cfg: { tickMs: 10, maxRetry: 2 } });
    const T = Date.now();
    st.add({ at: T + 5, body: '永远发不出去', human: fmt(T + 5) });
    let calls = 0;
    st.start({ onDue: async () => { calls += 1; return false; } });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(calls >= 2, `应至少试 2 次，实际 ${calls}`);
    assert.strictEqual(st.listPending().length, 0, '放弃后应从列表移除');
    fs.unlinkSync(file);
  });

  console.log(`\n通过 ${pass} 项`);
}

main().catch((e) => {
  console.error('\n✗ 失败：', e && e.message);
  process.exit(1);
});
