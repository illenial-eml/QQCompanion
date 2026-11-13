'use strict';
// 「她自己的日子」测试：计划挑选 / 跨天 / 提示词片段 / 日记素材
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLife, pickCurrent, parseHHMM, dayKeyOf, dateTextOf, bjParts, FALLBACK_PLAN } = require('../src/life');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-'));
const silent = { info() {}, warn() {}, error() {} };

// 假 brain：返回固定计划
function fakeBrain(items) {
  return {
    calls: 0,
    async _complete() {
      this.calls++;
      return JSON.stringify(items);
    },
  };
}

(async () => {
  await ok('parseHHMM', () => {
    assert.strictEqual(parseHHMM('09:30'), 570);
    assert.strictEqual(parseHHMM('9：5'), 545);
    assert.strictEqual(parseHHMM('25:00'), -1);
    assert.strictEqual(parseHHMM('abc'), -1);
  });

  await ok('pickCurrent 挑出当前在做的事', () => {
    const items = [
      { at: '09:00', title: '看书' },
      { at: '14:00', title: '整理东西' },
      { at: '20:00', title: '听歌' },
    ];
    assert.strictEqual(pickCurrent(items, 600).item.title, '看书');
    assert.strictEqual(pickCurrent(items, 900).item.title, '整理东西');
    assert.ok(pickCurrent(items, 900).minutesSince > 0);
    assert.strictEqual(pickCurrent(items, 1300).item.title, '听歌');
  });

  await ok('一天的开始之前：pre=true 且指向第一件事', () => {
    const items = [{ at: '09:00', title: '看书' }];
    const r = pickCurrent(items, 300);
    assert.strictEqual(r.pre, true);
    assert.strictEqual(r.item.title, '看书');
  });

  await ok('没有计划时返回空', () => {
    assert.strictEqual(pickCurrent([], 600).item, null);
  });

  await ok('ensurePlan 用模型排计划并落盘', async () => {
    const brain = fakeBrain([
      { at: '08:30', title: '赖床，听窗外的声音' },
      { at: '10:00', title: '翻那本没看完的书' },
      { at: '15:00', title: '整理今天看到的东西' },
      { at: '21:00', title: '听歌，发呆' },
    ]);
    const file = path.join(tmp, 'life1.json');
    const life = createLife({ brain, cfg: {}, log: silent, file, now: () => Date.parse('2026-11-09T12:00:00+08:00') });
    const st = await life.ensurePlan();
    assert.strictEqual(st.items.length, 4);
    assert.strictEqual(brain.calls, 1);
    assert.ok(fs.existsSync(file));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(saved.items[0].title, '赖床，听窗外的声音');
  });

  await ok('同一天再调 ensurePlan 不会再请求模型', async () => {
    const brain = fakeBrain([{ at: '09:00', title: 'A' }, { at: '14:00', title: 'B' }, { at: '20:00', title: 'C' }]);
    const file = path.join(tmp, 'life2.json');
    const now = Date.parse('2026-11-09T12:00:00+08:00');
    const life = createLife({ brain, cfg: {}, log: silent, file, now: () => now });
    await life.ensurePlan();
    await life.ensurePlan();
    assert.strictEqual(brain.calls, 1);
  });

  await ok('模型给的计划不合法时用模板兜底', async () => {
    const brain = { async _complete() { return '我不会'; } };
    const file = path.join(tmp, 'life3.json');
    const life = createLife({ brain, cfg: {}, log: silent, file, now: () => Date.parse('2026-11-09T12:00:00+08:00') });
    const st = await life.ensurePlan();
    assert.strictEqual(st.items.length, FALLBACK_PLAN.length);
  });

  await ok('模型抛错也能兜底（不崩）', async () => {
    const brain = { async _complete() { throw new Error('timeout'); } };
    const file = path.join(tmp, 'life4.json');
    const life = createLife({ brain, cfg: {}, log: silent, file, now: () => Date.parse('2026-11-09T12:00:00+08:00') });
    const st = await life.ensurePlan();
    assert.ok(st.items.length >= 3);
  });

  await ok('提示词片段包含当前在做的事，且不含「等主人」', async () => {
    const brain = fakeBrain([
      { at: '08:30', title: '赖床' },
      { at: '10:00', title: '翻那本没看完的书' },
      { at: '21:00', title: '听歌' },
    ]);
    const file = path.join(tmp, 'life5.json');
    const life = createLife({ brain, cfg: {}, log: silent, file, now: () => Date.parse('2026-11-09T11:30:00+08:00') });
    await life.ensurePlan();
    const text = life.contextForPrompt();
    assert.ok(text.includes('你自己的一天'), text);
    assert.ok(text.includes('翻那本没看完的书'), text);
    assert.ok(!/等主人|等他说话|守着/.test(text), '不该出现等主人：' + text);
  });

  await ok('日记素材带计划 + 当前 + 聊天条数', async () => {
    const brain = fakeBrain([{ at: '09:00', title: 'A' }, { at: '14:00', title: 'B' }, { at: '20:00', title: 'C' }]);
    const file = path.join(tmp, 'life6.json');
    const life = createLife({ brain, cfg: {}, log: silent, file, now: () => Date.parse('2026-11-09T15:00:00+08:00') });
    await life.ensurePlan();
    life.countChat(3);
    const m = life.diaryMaterial();
    assert.strictEqual(m.items.length, 3);
    assert.strictEqual(m.current, 'B');
    assert.strictEqual(m.chats, 3);
  });

  await ok('跨天会重排（day 变了）', async () => {
    let t = Date.parse('2026-11-09T12:00:00+08:00');
    const brain = fakeBrain([{ at: '09:00', title: 'A' }, { at: '14:00', title: 'B' }, { at: '20:00', title: 'C' }]);
    const file = path.join(tmp, 'life7.json');
    const life = createLife({ brain, cfg: {}, log: silent, file, now: () => t });
    await life.ensurePlan();
    const d1 = life.state().day;
    t = Date.parse('2026-11-10T12:00:00+08:00');
    await life.ensurePlan();
    assert.notStrictEqual(life.state().day, d1);
    assert.strictEqual(brain.calls, 2);
  });

  await ok('禁用后不生成提示词', async () => {
    const file = path.join(tmp, 'life8.json');
    const life = createLife({ brain: fakeBrain([]), cfg: { enabled: false }, log: silent, file });
    assert.strictEqual(life.contextForPrompt(), '');
  });

  await ok('dayKeyOf / dateTextOf 用北京时间', () => {
    const t = Date.parse('2026-11-09T00:30:00+08:00');
    assert.strictEqual(dayKeyOf(t, 0), '2026-11-09');
    assert.strictEqual(dateTextOf(t), '11月9日 周一');
    assert.deepStrictEqual(bjParts(t).hh, 0);
  });

  // ---------- 真的做过的事（刷B站这类）----------
  await ok('noteActivity 记下她做过的事，并能取最近一件', async () => {
    const file = path.join(tmp, 'life-act.json');
    let t = Date.parse('2026-11-13T15:20:00+08:00');
    const life = createLife({ brain: fakeBrain(FALLBACK_PLAN), cfg: {}, log: silent, file, now: () => t });
    await life.ensurePlan();
    const rec = life.noteActivity({ kind: 'bili', title: '刷B站，看了《猫猫视频》', note: '这只猫也太胖了' });
    assert.ok(rec);
    assert.strictEqual(rec.at, '15:20');
    assert.strictEqual(life.state().did.length, 1);
    const near = life.recentActivity({ withinMinutes: 60 });
    assert.ok(near && near.title.includes('刷B站'));
    assert.strictEqual(near.note, '这只猫也太胖了');
  });

  await ok('两小时前的活动不算「刚才」', async () => {
    const file = path.join(tmp, 'life-act2.json');
    let t = Date.parse('2026-11-13T15:20:00+08:00');
    const life = createLife({ brain: fakeBrain(FALLBACK_PLAN), cfg: {}, log: silent, file, now: () => t });
    await life.ensurePlan();
    life.noteActivity({ kind: 'bili', title: '刷B站，看了《旧视频》' });
    t += 3 * 3600 * 1000;
    assert.strictEqual(life.recentActivity({ withinMinutes: 120 }), null);
  });

  await ok('提示词里会带「你刚才自己在…」和今天做过的事', async () => {
    const file = path.join(tmp, 'life-act3.json');
    const t = Date.parse('2026-11-13T15:20:00+08:00');
    const life = createLife({ brain: fakeBrain(FALLBACK_PLAN), cfg: {}, log: silent, file, now: () => t });
    await life.ensurePlan();
    life.noteActivity({ kind: 'bili', title: '刷B站，看了《猫猫视频》', note: '这只猫也太胖了' });
    const txt = life.contextForPrompt();
    assert.ok(txt.includes('你刚才自己在刷B站'));
    assert.ok(txt.includes('这只猫也太胖了'));
    assert.ok(txt.includes('今天你自己做过'));
  });

  await ok('日记素材带上做过的事', async () => {
    const file = path.join(tmp, 'life-act4.json');
    const t = Date.parse('2026-11-13T15:20:00+08:00');
    const life = createLife({ brain: fakeBrain(FALLBACK_PLAN), cfg: {}, log: silent, file, now: () => t });
    await life.ensurePlan();
    life.noteActivity({ kind: 'bili', title: '刷B站，看了《猫猫视频》', note: '这只猫也太胖了' });
    const m = life.diaryMaterial();
    assert.ok(m.did.length === 1);
    assert.ok(m.did[0].includes('刷B站'));
    assert.ok(m.did[0].includes('这只猫也太胖了'));
  });

  await ok('跨天重排计划会清空「今天做过的事」', async () => {
    const file = path.join(tmp, 'life-act5.json');
    let t = Date.parse('2026-11-13T15:20:00+08:00');
    const life = createLife({ brain: fakeBrain(FALLBACK_PLAN), cfg: {}, log: silent, file, now: () => t });
    await life.ensurePlan();
    life.noteActivity({ kind: 'bili', title: '刷B站，看了《猫猫视频》' });
    assert.strictEqual(life.state().did.length, 1);
    t = Date.parse('2026-11-14T09:00:00+08:00');
    await life.ensurePlan();
    assert.strictEqual(life.state().did.length, 0);
  });

  await ok('noteActivity 空标题不记、禁用时不记', async () => {
    const file = path.join(tmp, 'life-act6.json');
    const life = createLife({ brain: fakeBrain(FALLBACK_PLAN), cfg: {}, log: silent, file });
    assert.strictEqual(life.noteActivity({ title: '' }), null);
    const off = createLife({ brain: null, cfg: { enabled: false }, log: silent, file: path.join(tmp, 'life-act7.json') });
    assert.strictEqual(off.noteActivity({ title: '刷B站' }), null);
  });

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exitCode = fail ? 1 : 0;
})();
