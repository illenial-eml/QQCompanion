'use strict';
/**
 * 新增功能的测试（2026-10-28）：
 *   1) 重复日程：每天 / 每周X / 每月N号，以及「发完自动排下一次」
 *   2) 考试登记 + 倒计时
 *   3) 每日简报（课表 + 今天要提醒的 + 考试）
 *   4) 日程撞课检测（timetable.conflictAt）
 *   5) 群聊发言节奏自适应（很热闹时提前收口）
 *
 * 这些都是纯本地逻辑，不联网、不调模型。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createReminderStore, parseReminder, parseRepeat, nextOccurrence, repeatText } = require('../src/reminders');
const { createExamStore, parseExam } = require('../src/exams');
const { buildBrief, shouldSend } = require('../src/dailybrief');
const { createTimetable } = require('../src/timetable');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-new-'));
const fileOf = (n) => path.join(tmp, n);

// 基准时间：2026-10-28 20:00 北京时间（周三）
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const bj = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');

console.log('\n【重复日程】');
ok('每周三晚8点 → 已过点，排到下周三 20:00', () => {
  const r = parseRepeat('每周三晚8点提醒我开会');
  assert.deepStrictEqual({ k: r.kind, wd: r.wd, h: r.h }, { k: 'weekly', wd: 3, h: 20 });
  assert.strictEqual(bj(nextOccurrence(r, NOW)), '2026-11-04 20:00');
});
ok('每天9点 → 明天 09:00', () => {
  const x = parseReminder('每天9点提醒我吃药', NOW);
  assert.ok(x && x.repeat && x.repeat.kind === 'daily');
  assert.strictEqual(bj(x.at), '2026-10-29 09:00');
  assert.strictEqual(x.body, '吃药');
});
ok('每月15号 → 11月15日 09:00（本月已过）', () => {
  const x = parseReminder('每月15号提醒我交房租', NOW);
  assert.strictEqual(x.repeat.kind, 'monthly');
  assert.strictEqual(bj(x.at), '2026-11-15 09:00');
});
ok('一次性日程不带 repeat', () => {
  const x = parseReminder('明天9点提醒我开会', NOW);
  assert.ok(x && !x.repeat);
});
ok('repeatText 中文可读', () => {
  assert.strictEqual(repeatText({ kind: 'weekly', wd: 3, h: 20, mi: 0 }), '每周三 20:00');
  assert.strictEqual(repeatText({ kind: 'daily', h: 9, mi: 5 }), '每天 09:05');
});
ok('发完自动排下一次（reschedule）', () => {
  const store = createReminderStore({ file: fileOf('r1.json'), now: () => NOW });
  const rep = parseRepeat('每天8点提醒我背单词');
  const r = store.add({ at: nextOccurrence(rep, NOW), body: '背单词', human: 'x', repeat: rep });
  assert.ok(r.ok);
  const nx = store.reschedule(r.item);
  assert.ok(nx, '应该排出一条新的');
  assert.strictEqual(nx.at - r.item.at, 86400000);
  assert.strictEqual(store.listPending().length, 2);
});
ok('删掉重复日程后不再排下一次', () => {
  const store = createReminderStore({ file: fileOf('r2.json'), now: () => NOW });
  const rep = { kind: 'daily', h: 8, mi: 0 };
  const r = store.add({ at: nextOccurrence(rep, NOW), body: '背单词', human: 'x', repeat: rep });
  store.cancelById(r.item.id);
  assert.strictEqual(store.listPending().length, 0);
});

console.log('\n【考试登记】');
ok('12月28日晚上 → 19:00 默认', () => {
  const e = parseExam('考试 12月28日 晚上 高等数学', NOW);
  assert.ok(e);
  assert.strictEqual(e.name, '高等数学');
  assert.strictEqual(bj(e.at), '2026-12-28 19:00');
});
ok('12月29号下午2点 → 14:00', () => {
  const e = parseExam('记一下 12月29号下午2点 普通化学考试', NOW);
  assert.strictEqual(bj(e.at), '2026-12-29 14:00');
  assert.strictEqual(e.name, '普通化学');
});
ok('不是考试的话不认', () => {
  assert.strictEqual(parseExam('明天记得吃饭', NOW), null);
});
ok('倒计时文案 + 去重 + 删除', () => {
  const store = createExamStore({ file: fileOf('e1.json'), now: () => NOW });
  const e = parseExam('考试 12月28日 高数', NOW);
  const a = store.add(e);
  assert.ok(a.ok);
  const b = store.add(parseExam('考试 12月28日 高数', NOW));
  assert.strictEqual(b.reason, 'dup');
  assert.ok(store.view(NOW).includes('还有 61 天'), store.view(NOW));
  const rm = store.removeByIndex(1);
  assert.strictEqual(rm.name, '高数');
  assert.strictEqual(store.listUpcoming(NOW).length, 0);
});

console.log('\n【每日简报】');
ok('简报带课表 / 日程 / 考试', () => {
  const tt = createTimetable({
    file: fileOf('tt.json'),
    now: () => NOW,
    cfg: { semesterStart: '2026-09-07' },
  });
  // 周三 10-11 节：普通生物学
  tt.addSession({ day: 3, periods: [10, 11], name: '普通生物学', place: '理教106' });
  const rs = createReminderStore({ file: fileOf('r3.json'), now: () => NOW });
  rs.add({ at: NOW + 3600000, body: '交作业', human: '10月28日 周三 21:00' });
  const es = createExamStore({ file: fileOf('e2.json'), now: () => NOW });
  es.add(parseExam('考试 12月28日 高数', NOW));
  const text = buildBrief({ timetable: tt, reminderStore: rs, examStore: es, now: NOW, cfg: { examWindowDays: 120 } });
  assert.ok(text.includes('早，10月28日'), text);
  assert.ok(text.includes('普通生物学'), text);
  assert.ok(text.includes('交作业'), text);
  assert.ok(text.includes('高数'), text);
});
ok('shouldSend：到点才发、每天只一次', () => {
  const state = { lastKey: '' };
  const at7 = Date.UTC(2026, 9, 28, 23, 0, 0);  // 北京 10/29 07:00
  const at8 = Date.UTC(2026, 9, 29, 0, 0, 0);   // 北京 10/29 08:00
  assert.strictEqual(shouldSend(state, at7, { hour: 8 }), false);
  assert.strictEqual(shouldSend(state, at8, { hour: 8 }), true);
  state.lastKey = '2026-10-29';
  assert.strictEqual(shouldSend(state, at8, { hour: 8 }), false);
});

console.log('\n【日程撞课】');
ok('冲突检测命中正在上的课', () => {
  const tt = createTimetable({
    file: fileOf('tt2.json'),
    now: () => NOW,
    cfg: { semesterStart: '2026-09-07' },
  });
  tt.addSession({ day: 3, periods: [5, 6], name: '高数' });
  // 周三 13:30（第5节 13:00-13:50 之间）
  const at = Date.UTC(2026, 9, 28, 5, 30, 0);
  const hit = tt.conflictAt(at);
  assert.ok(hit && hit.session.name === '高数', JSON.stringify(hit));
  // 周三 21:00 没课
  assert.strictEqual(tt.conflictAt(Date.UTC(2026, 9, 28, 13, 0, 0)), null);
});
ok('remainingToday 只列还没开始的', () => {
  const tt = createTimetable({
    file: fileOf('tt3.json'),
    now: () => NOW,
    cfg: { semesterStart: '2026-09-07' },
  });
  tt.addSession({ day: 3, periods: [5, 6], name: '高数' });
  tt.addSession({ day: 3, periods: [10, 11], name: '普生' });
  const left = tt.remainingToday(NOW); // 20:00，普生 19:40 已开始
  assert.strictEqual(left.length, 0, JSON.stringify(left.map((x) => x.session.name)));
});

console.log(`\n通过 ${pass} 项`);
