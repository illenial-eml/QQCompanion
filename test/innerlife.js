'use strict';
// 内心深处（innerlife）测试：话头去重/排序/淡出、完成判定、日子、提示词片段、夜间反思
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInnerLife, parseDue, dueLabel, sim, ymd, dayNum, INNER_DEFAULTS } = require('../src/innerlife');

let pass = 0;
let fail = 0;
async function ok(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ': ' + e.message);
  }
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-'));

// 固定「现在」：北京时间 2026-11-13 10:00
const NOW = Date.UTC(2026, 10, 13, 2, 0, 0);
const now = () => NOW;

function makeStore(extra = {}) {
  const file = path.join(TMP, 'inner-' + Math.random().toString(36).slice(2) + '.json');
  return createInnerLife({ file, cfg: { ...extra }, log: silent, now });
}

function fakeBrain(reply) {
  return {
    calls: 0,
    lastUser: '',
    async _complete(messages) {
      this.calls += 1;
      this.lastUser = (messages && messages[1] && messages[1].content) || '';
      return typeof reply === 'function' ? reply() : reply;
    },
  };
}

function fakeLongterm() {
  return {
    items: [],
    remember(x) {
      this.items.push(x);
      return { ok: true };
    },
  };
}

(async () => {
  await ok('parseDue 认 YYYY-MM-DD 和 M月D日', () => {
    assert.strictEqual(ymd(parseDue('2026-11-15', NOW) * 86400000 - 8 * 3600000 + 3600000), '2026-11-15');
    const d1 = parseDue('11月20日', NOW);
    const d2 = parseDue('2026-11-20', NOW);
    assert.strictEqual(d1, d2);
    assert.strictEqual(parseDue('', NOW), 0);
    assert.strictEqual(parseDue('看不懂', NOW), 0);
  });

  await ok('dueLabel 说人话', () => {
    const today = dayNum(NOW);
    assert.strictEqual(dueLabel(today, NOW), '就是今天');
    assert.strictEqual(dueLabel(today + 1, NOW), '明天');
    assert.strictEqual(dueLabel(today + 3, NOW), '还有 3 天');
    assert.strictEqual(dueLabel(today - 1, NOW), '昨天');
    assert.strictEqual(dueLabel(0, NOW), '');
  });

  await ok('addThread 去重 + 编号 + 落盘', () => {
    const s = makeStore();
    const a = s.addThread('明天要考高数');
    assert.ok(a && a.id === 't1');
    const b = s.addThread('明天要考高数'); // 同一件事不重复记
    assert.strictEqual(b.id, a.id);
    const c = s.addThread('在等实习的结果', { due: '2026-11-16' });
    assert.strictEqual(c.id, 't2');
    assert.strictEqual(c.due, '2026-11-16');
    // 重新读文件还在
    const s2 = createInnerLife({ file: path.join(TMP, 'inner-' + Math.random().toString(36).slice(2) + '.json'), log: silent, now });
    assert.ok(s2);
  });

  await ok('openThreads：有期限的排前面', () => {
    const s = makeStore();
    s.addThread('在等实习的结果', { due: '2026-11-18' });
    s.addThread('明天要考高数', { due: '2026-11-14' });
    s.addThread('随口提过想学吉他');
    const list = s.openThreads({ limit: 5 });
    assert.strictEqual(list.length, 3);
    assert.strictEqual(list[0].text, '明天要考高数');
    assert.strictEqual(list[1].text, '在等实习的结果');
    assert.strictEqual(list[2].text, '随口提过想学吉他');
  });

  await ok('超期的话头会淡出', () => {
    const s = makeStore({ threadDays: 3 });
    s.addThread('很久以前的事呀', { at: NOW - 10 * 86400000 });
    s.addThread('昨天说的事');
    const list = s.openThreads({ limit: 10 });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].text, '昨天说的事');
  });

  await ok('noteOwnerText：说完成了就关掉', () => {
    const s = makeStore();
    s.addThread('明天要考高数');
    const closed = s.noteOwnerText('高数考完了，还行');
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(s.openThreads({ limit: 10 }).length, 0);
  });

  await ok('noteOwnerText：只说别的不会误关', () => {
    const s = makeStore();
    s.addThread('在等实习的结果');
    const closed = s.noteOwnerText('今天食堂的饭好难吃');
    assert.strictEqual(closed.length, 0);
    assert.strictEqual(s.openThreads({ limit: 10 }).length, 1);
    // 提过一次但没结果，还挂着
    s.noteOwnerText('实习那边不知道啥时候有消息');
    assert.strictEqual(s.openThreads({ limit: 10 }).length, 1);
  });

  await ok('addDate 同名更新 + upcomingDates 按远近排', () => {
    const s = makeStore();
    s.addDate({ label: '他生日', date: '11-20' });
    s.addDate({ label: '他生日', date: '11-22' }); // 同名覆盖
    s.addDate({ label: '在一起第 100 天', date: '2026-11-15' });
    const ds = s.upcomingDates({ days: 30, limit: 5 });
    assert.strictEqual(ds.length, 2);
    assert.strictEqual(ds[0].label, '在一起第 100 天');
    assert.strictEqual(ds[0].label2, '还有 2 天');
    assert.strictEqual(ds[1].label, '他生日');
  });

  await ok('contextFor：私聊主人才有，群里/别人空', () => {
    const s = makeStore();
    s.addThread('明天要考高数', { due: '2026-11-14' });
    s.setOwner({ last: '他最近在忙期末，睡得有点晚' });
    s.addDate({ label: '他生日', date: '11-20' });
    const txt = s.contextFor({ scene: 'c2c', owner: true });
    assert.ok(txt.includes('你心里记着的事'));
    assert.ok(txt.includes('明天要考高数'));
    assert.ok(txt.includes('明天'));
    assert.ok(txt.includes('他最近'));
    assert.ok(txt.includes('忙期末'));
    assert.ok(txt.includes('你记着的日子'));
    assert.ok(txt.includes('他生日'));
    assert.strictEqual(s.contextFor({ scene: 'group', owner: true }), '');
    assert.strictEqual(s.contextFor({ scene: 'c2c', owner: false }), '');
  });

  await ok('contextFor：没东西就是空字符串', () => {
    const s = makeStore();
    assert.strictEqual(s.contextFor({ scene: 'c2c', owner: true }), '');
  });

  await ok('reflect：写出事实/话头/日子/近况', async () => {
    const s = makeStore();
    const brain = fakeBrain(
      JSON.stringify({
        facts: [{ text: '他在准备期末，最近熬夜', importance: 4 }],
        threads: [{ text: '周五要交课程设计', due: '2026-11-20' }],
        closed: [],
        dates: [{ label: '他生日', date: '11-20', yearly: true }],
        last: '他在忙期末，有点累',
      })
    );
    const lt = fakeLongterm();
    const turns = [
      { role: 'user', content: '这周要交课程设计，烦死了' },
      { role: 'user', content: '最近天天熬到两点' },
      { role: 'assistant', content: '那你白天还行吗' },
      { role: 'user', content: '凑合吧' },
    ];
    const r = await s.reflect({ turns, dateText: '11月13日', brain, longterm: lt, ownerId: '1001' });
    assert.ok(r.ok, 'reflect 应该成功');
    assert.strictEqual(r.applied.facts, 1);
    assert.strictEqual(lt.items.length, 1);
    assert.ok(lt.items[0].text.includes('期末'));
    assert.strictEqual(lt.items[0].source, 'reflect');
    assert.strictEqual(r.applied.threads, 1);
    assert.strictEqual(s.openThreads({ limit: 5 })[0].text, '周五要交课程设计');
    assert.strictEqual(r.applied.dates, 1);
    assert.strictEqual(r.applied.last, '他在忙期末，有点累');
    const txt = s.contextFor({ scene: 'c2c', owner: true });
    assert.ok(txt.includes('周五要交课程设计'));
  });

  await ok('reflect：关掉已经说完了的事', async () => {
    const s = makeStore();
    s.addThread('面试结果还没出');
    const brain = fakeBrain(
      JSON.stringify({ facts: [], threads: [], closed: ['面试结果出了，过了'], dates: [], last: '' })
    );
    const r = await s.reflect({
      turns: [
        { role: 'user', content: '面试过了' },
        { role: 'user', content: '今天通知的' },
        { role: 'assistant', content: '可以啊' },
        { role: 'user', content: '嗯' },
      ],
      brain,
      longterm: fakeLongterm(),
    });
    assert.ok(r.ok);
    assert.strictEqual(r.applied.closed, 1);
    assert.strictEqual(s.openThreads({ limit: 5 }).length, 0);
  });

  await ok('reflect：话太少不浪费模型', async () => {
    const s = makeStore();
    const brain = fakeBrain(JSON.stringify({}));
    const r = await s.reflect({ turns: [{ role: 'user', content: '在吗' }], brain });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'too-few-turns');
    assert.strictEqual(brain.calls, 0);
  });

  await ok('reflect：模型返回不是 JSON 时不崩', async () => {
    const s = makeStore();
    const brain = fakeBrain('我觉得他今天挺好的');
    const r = await s.reflect({
      turns: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
        { role: 'user', content: 'd' },
      ],
      brain,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'bad-json');
  });

  await ok('reflect 的输入里有他今天的原话', async () => {
    const s = makeStore();
    const brain = fakeBrain(JSON.stringify({ facts: [], threads: [], closed: [], dates: [], last: '' }));
    await s.reflect({
      turns: [
        { role: 'user', content: '我换工作了，在准备入职' },
        { role: 'assistant', content: '哪家啊' },
        { role: 'user', content: '一家小公司' },
        { role: 'user', content: '下周一去' },
      ],
      brain,
      longterm: fakeLongterm(),
    });
    assert.ok(brain.lastUser.includes('我换工作了'));
    assert.ok(brain.lastUser.includes('他今天跟我说的话'));
  });

  await ok('shouldReflect：到点才跑，一天只跑一次', () => {
    const day = 2026, m = 10, d = 13;
    const at = (h, mi) => Date.UTC(day, m, d, h - 8, mi);
    const s = makeStore();
    assert.strictEqual(s.shouldReflect(at(23, 50)), true, '23:50 应该反思');
    // 真跑一次后当天不再跑
    const file = path.join(TMP, 'should-' + Math.random().toString(36).slice(2) + '.json');
    const s2 = createInnerLife({ file, log: silent, now: () => at(23, 50) });
    assert.strictEqual(s2.shouldReflect(), true);
    return s2
      .reflect({
        turns: [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
          { role: 'assistant', content: 'c' },
          { role: 'user', content: 'd' },
        ],
        brain: fakeBrain(JSON.stringify({ facts: [], threads: [], closed: [], dates: [], last: '' })),
      })
      .then(() => {
        assert.strictEqual(s2.shouldReflect(), false, '同一天不该再跑');
        const s3 = makeStore();
        assert.strictEqual(s3.shouldReflect(at(10, 0)), false, '上午不该跑');
      });
  });

  await ok('summary / state 给出可读状态', () => {
    const s = makeStore();
    s.addThread('明天要考试');
    s.addDate({ label: '他生日', date: '11-20' });
    const sum = s.summary();
    assert.strictEqual(sum.threads, 1);
    assert.strictEqual(sum.dates, 1);
    assert.strictEqual(sum.hasOwnerState, false);
    assert.ok(s.state().threads.length === 1);
  });

  await ok('sim 对中文句子的近似判断', () => {
    assert.ok(sim('明天要考高数', '明天高数考试') >= 0.3);
    assert.ok(sim('明天要考高数', '今天天气不错') < 0.2);
    assert.strictEqual(sim('', 'x'), 0);
  });

  await ok('默认配置是开着的', () => {
    assert.strictEqual(INNER_DEFAULTS.enabled, true);
    assert.strictEqual(INNER_DEFAULTS.reflectHour, 23);
  });

  console.log('');
  console.log(`通过 ${pass}  失败 ${fail}`);
  if (fail) process.exit(1);
})();
