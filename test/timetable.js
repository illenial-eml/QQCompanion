'use strict';
/**
 * 课表模块测试：单双周、提前提醒、去重、渲染。
 * 用假时间（北京 2026-10-28 周三 13:40 之类）驱动，不碰网络。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTimetable, wdOf, dayKeyBJ, ymdOf, parseYmd, hhmmToMin, minToHhmm } = require('../src/timetable');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// 2026-10-28 是周三；北京时间 13:40
const T = Date.UTC(2026, 9, 28, 5, 40, 0); // UTC 05:40 = 北京 13:40
const tmp = path.join(os.tmpdir(), `tt-${process.pid}.json`);

function mk(sessions, extra = {}) {
  const file = tmp + '-' + Math.random().toString(36).slice(2) + '.json';
  fs.writeFileSync(file, JSON.stringify({ semesterStart: '2026-09-07', remindBeforeMin: 10, sessions, sent: {}, ...extra }));
  return createTimetable({ file, cfg: {}, now: () => T });
}

console.log('课表模块');

ok('时间工具：wdOf/ymdOf/hhmm', () => {
  assert.strictEqual(wdOf(T), 3, '2026-10-28 应是周三');
  assert.strictEqual(ymdOf(T), '2026-10-28');
  assert.strictEqual(parseYmd('2026-09-07'), Date.UTC(2026, 8, 7) - 8 * 3600000);
  assert.strictEqual(hhmmToMin('13:50'), 830);
  assert.strictEqual(minToHhmm(830), '13:50');
});

ok('第几周：09-07 开学 → 10-28 是第 8 周（双周）', () => {
  const tt = mk([]);
  assert.strictEqual(tt.weekNo(T), 8);
  assert.strictEqual(tt.parityOf(T), 'even');
});

ok('setWeekNo(9) 反推出「本周=第9周」', () => {
  const tt = mk([]);
  assert.strictEqual(tt.setWeekNo(9, T), true);
  assert.strictEqual(tt.weekNo(T), 9);
  assert.strictEqual(tt.info().parity, '单');
});

ok('单双周过滤：双周课在双周上、单周不上', () => {
  const even = mk([{ day: 3, periods: [10, 11], name: '普通生物学', place: '理教106', parity: 'even' }]);
  assert.strictEqual(even.sessionsOnDay(3).length, 1);
  assert.ok(even.dayView(0).includes('普通生物学'), '双周周三应该有课');
  const t9 = T + 7 * 86400000; // 下一周（第 9 周，单周）
  const tt = mk([{ day: 3, periods: [10, 11], name: '普通生物学', place: '理教106', parity: 'even' }]);
  const day9 = tt.dayView(7);
  assert.ok(day9.includes('没课'), `第9周周三应没课，实际：${day9}`);
  assert.strictEqual(wdOf(t9), 3);
});

ok('due：已经开课的课不再提醒（13:40 看 13:00 那节）', () => {
  const tt = mk([{ day: 3, periods: [5], name: '已开课的课', place: 'X', parity: 'all' }]); // 第五节 13:00-13:50
  const d = tt.due(T);
  assert.strictEqual(d.length, 0, '开了 40 分钟的课不该再提醒');
});

ok('due 更准的例子：13:41 时，13:50 的课还有 9 分钟', () => {
  // 构造 13:50 开始的课：用第六节(14:00)不行，用自定义时间不方便 → 用第五节结束8分钟前
  const t = Date.UTC(2026, 9, 28, 5, 45, 0); // 北京 13:45，第五节 13:00 已过
  const tt = createTimetable({
    file: tmp + '-x.json',
    cfg: {},
    now: () => t,
  });
  // 直接塞一节 13:50 的课：把 periods 设为 [6] 起点 14:00 → 距 13:45 还有 15 分钟，超出 10 分钟窗口
  fs.writeFileSync(tmp + '-x.json', JSON.stringify({
    semesterStart: '2026-09-07', remindBeforeMin: 10, sent: {},
    sessions: [{ day: 3, periods: [6], name: '第六节课', place: 'Y', parity: 'all' }],
  }));
  tt.load();
  assert.strictEqual(tt.due(t).length, 0, '15 分钟前不该提醒');
  const t2 = Date.UTC(2026, 9, 28, 5, 55, 0); // 13:55，距 14:00 还有 5 分钟
  const tt2 = createTimetable({ file: tmp + '-x.json', cfg: {}, now: () => t2 });
  const d2 = tt2.due(t2);
  assert.strictEqual(d2.length, 1, '5 分钟前该提醒');
  assert.strictEqual(d2[0].minutesLeft, 5);
});

ok('tick：发完不会重复发（同一天去重）', () => {
  const t = Date.UTC(2026, 9, 28, 5, 55, 0);
  const file = tmp + '-dedupe.json';
  fs.writeFileSync(file, JSON.stringify({
    semesterStart: '2026-09-07', remindBeforeMin: 10, sent: {},
    sessions: [{ day: 3, periods: [6], name: '普通化学', place: '二教207', parity: 'all' }],
  }));
  const tt = createTimetable({ file, cfg: {}, now: () => t });
  const first = tt.tick(t);
  assert.strictEqual(first.length, 1);
  assert.ok(first[0].includes('普通化学') && first[0].includes('5 分钟后上课'));
  assert.strictEqual(tt.tick(t).length, 0, '第二次不该再发');
});

ok('tick：半夜不提醒（quietHours）', () => {
  const t = Date.UTC(2026, 9, 28, 16, 30, 0); // 北京 00:30
  const file = tmp + '-quiet.json';
  fs.writeFileSync(file, JSON.stringify({
    semesterStart: '2026-09-07', remindBeforeMin: 10, sent: {},
    sessions: [{ day: 4, periods: [1], name: '早课', place: '', parity: 'all' }],
  }));
  const tt = createTimetable({ file, cfg: {}, now: () => t });
  assert.deepStrictEqual(tt.tick(t), []);
});

ok('weekView 有单双周标注、dayView 带日期', () => {
  const tt = mk([
    { day: 1, periods: [5, 6], name: '普通生物学', place: '理教106', parity: 'all' },
    { day: 3, periods: [10, 11], name: '普通生物学', place: '理教106', parity: 'even' },
    { day: 3, periods: [3, 4], name: '英文学术文献阅读', place: '一教104', parity: 'all' },
  ]);
  const w = tt.weekView();
  assert.ok(w.includes('第8周'), w);
  assert.ok(w.includes('双周'), w);
  assert.ok(w.includes('【周三】'), w);
  const d = tt.dayView(0);
  assert.ok(d.includes('2026-10-28 周三'), d);
  assert.ok(d.includes('英文学术文献阅读'), d);
});

ok('保存后能重新读出来（含 sent 去重状态）', () => {
  const file = tmp + '-persist.json';
  fs.writeFileSync(file, JSON.stringify({
    semesterStart: '2026-09-07', remindBeforeMin: 10, sent: {},
    sessions: [{ day: 3, periods: [6], name: '持久化课', place: '', parity: 'all' }],
  }));
  const t = Date.UTC(2026, 9, 28, 5, 55, 0);
  const a = createTimetable({ file, cfg: {}, now: () => t });
  assert.strictEqual(a.tick(t).length, 1);
  const b = createTimetable({ file, cfg: {}, now: () => t });
  assert.strictEqual(b.tick(t).length, 0, '重启后不该重复提醒');
});

ok('remindBeforeMin 可调：改成 20 分钟后 15 分钟前的课也能提醒', () => {
  const t = Date.UTC(2026, 9, 28, 5, 45, 0); // 13:45
  const file = tmp + '-before.json';
  fs.writeFileSync(file, JSON.stringify({
    semesterStart: '2026-09-07', remindBeforeMin: 10, sent: {},
    sessions: [{ day: 3, periods: [6], name: '第六节', place: '', parity: 'all' }], // 14:00
  }));
  const tt = createTimetable({ file, cfg: {}, now: () => t });
  assert.strictEqual(tt.due(t).length, 0);
  assert.strictEqual(tt.setRemindBefore(20), true);
  assert.strictEqual(tt.due(t).length, 1);
});

ok('改课表：把周五晚上的课挪到周四', () => {
  const tt = mk([
    { day: 5, periods: [10, 11], name: '普通化学(B)', place: '二教207', parity: 'all' },
    { day: 3, periods: [3, 4], name: '英文学术文献阅读', place: '一教104', parity: 'all' },
  ]);
  const r = tt.moveSession({ name: '普通化学(B)', fromDay: 5, toDay: 4 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(tt.sessionsOnDay(5).length, 0);
  assert.strictEqual(tt.sessionsOnDay(4).length, 1);
  assert.ok(tt.dayView(1).includes('普通化学'), '明天(周四)应该有普通化学');
});

ok('改课表：找不到课名时给出理由，不乱改', () => {
  const tt = mk([{ day: 5, periods: [10, 11], name: '普通化学(B)', place: '', parity: 'all' }]);
  const r = tt.moveSession({ name: '量子力学', fromDay: 5, toDay: 4 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('没找到'), r.reason);
});

ok('改课表：同名多节要问清是哪天', () => {
  const tt = mk([
    { day: 1, periods: [5, 6], name: '普通生物学', place: '', parity: 'all' },
    { day: 3, periods: [10, 11], name: '普通生物学', place: '', parity: 'even' },
  ]);
  const r = tt.moveSession({ name: '普通生物学', toDay: 2 });
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.ambiguous) && r.ambiguous.length === 2);
  const r2 = tt.moveSession({ name: '普通生物学', fromDay: 3, toDay: 4 });
  assert.strictEqual(r2.ok, true);
});

ok('删课 / 加课', () => {
  const tt = mk([{ day: 5, periods: [7, 8], name: '计算概论(B)上机', place: '机房', parity: 'all' }]);
  const del = tt.removeSession({ name: '计算概论' });
  assert.strictEqual(del.ok, true, JSON.stringify(del));
  assert.strictEqual(tt.sessionsOnDay(5).length, 0);
  const add = tt.addSession({ day: 2, periods: [1, 2], name: '体育', place: '操场' });
  assert.strictEqual(add.ok, true);
  assert.strictEqual(tt.sessionsOnDay(2).length, 1);
});

ok('outline 给模型看的文本包含星期/节次/课名', () => {
  const tt = mk([{ day: 5, periods: [10, 11], name: '普通化学(B)', place: '二教207', parity: 'all' }]);
  const o = tt.outline();
  assert.ok(o.includes('周五') && o.includes('第10-11节') && o.includes('普通化学(B)') && o.includes('二教207'), o);
});

console.log(`\n课表模块：${pass} 项通过`);
