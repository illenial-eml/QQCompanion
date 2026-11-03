'use strict';
/**
 * test/selfmodel.js —— 自我意识迭代的单元测试
 * 不调真模型：用一个假的 brain._complete 返回预设 JSON。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSelfModel, similarity, extractJson } = require('../src/selfmodel');

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.log('  FAIL ' + name + ' → ' + e.message);
    process.exitCode = 1;
  }
}
async function okA(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.log('  FAIL ' + name + ' → ' + e.message);
    process.exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'));
const fileOf = (n) => path.join(tmp, n + '.json');

function fakeBrain(json) {
  return {
    _complete: async () => (typeof json === 'string' ? json : JSON.stringify(json)),
  };
}

function fakeLongterm(items) {
  return {
    list: () => items,
    remember: (o) => {
      const hit = items.find((i) => i.text === o.text);
      if (hit) return { ok: true, action: 'updated', item: hit };
      items.push(o);
      return { ok: true, action: 'added', item: o };
    },
  };
}

const evidence = {
  selfLines: ['a', 'b', 'c', 'd'],
  topics: ['e', 'f'],
  memories: [{ text: '他下周三要考生物化学' }],
  impressions: ['hukk 老发数字串'],
  state: '有点困',
};

(async () => {
  console.log('== 工具函数 ==');
  ok('similarity 相同为 1', () => assert.strictEqual(similarity('我讨厌香菜', '我讨厌香菜'), 1));
  ok('similarity 不同接近 0', () => assert.ok(similarity('我讨厌香菜', '今天天气不错') < 0.2));
  ok('extractJson 能从 ```json 包裹里取', () => {
    const j = extractJson('```json\n{"a":1}\n```');
    assert.deepStrictEqual(j, { a: 1 });
  });
  ok('extractJson 容忍前后废话', () => {
    const j = extractJson('好的，这是结果：{"a":{"b":2}} 完了');
    assert.deepStrictEqual(j, { a: { b: 2 } });
  });
  ok('extractJson 坏 JSON 返回 null', () => assert.strictEqual(extractJson('{不是json'), null));

  console.log('== 反思流程 ==');
  await okA('事件太少不反思', async () => {
    const sm = createSelfModel({ file: fileOf('few'), log: null });
    const r = await sm.reflect({ brain: fakeBrain({}), evidence: { selfLines: ['x'], topics: [] } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'too-few-events');
  });

  await okA('正常反思写入 views/styleHints/focus/mood', async () => {
    const sm = createSelfModel({ file: fileOf('normal'), log: null });
    const r = await sm.reflect({
      brain: fakeBrain({
        views: [{ text: '群里聊实验的时候我不太插得上话', confidence: 4 }],
        styleHints: ['别老用问句收尾'],
        focus: '想弄明白他们在说的国赛',
        mood: 'calm',
        memoryFixes: [],
      }),
      evidence,
    });
    assert.strictEqual(r.ok, true);
    const g = sm.get();
    assert.strictEqual(g.views.length, 1);
    assert.strictEqual(g.styleHints.length, 1);
    assert.strictEqual(g.focus, '想弄明白他们在说的国赛');
    assert.strictEqual(g.mood, 'calm');
    assert.strictEqual(g.history.length, 1);
  });

  await okA('format 能拼出提示词段落', async () => {
    const sm = createSelfModel({ file: fileOf('fmt'), log: null });
    await sm.reflect({
      brain: fakeBrain({
        views: [{ text: '被问专业的时候最好别装懂', confidence: 5 }],
        styleHints: ['一次多说一两句'],
        focus: '期末',
        mood: 'good',
        memoryFixes: [],
      }),
      evidence,
    });
    const f = sm.format();
    assert.ok(f.includes('你自己的想法'));
    assert.ok(f.includes('被问专业的时候最好别装懂'));
    assert.ok(f.includes('你自己总结的说话习惯'));
    assert.ok(f.includes('一次多说一两句'));
    assert.ok(f.includes('期末'));
  });

  await okA('相同看法的覆盖而不是重复追加', async () => {
    const sm = createSelfModel({ file: fileOf('dup'), log: null });
    const b = fakeBrain({ views: [{ text: '群里聊实验我插不上话', confidence: 3 }], styleHints: [], focus: '', mood: 'calm', memoryFixes: [] });
    await sm.reflect({ brain: b, evidence });
    await sm.reflect({ brain: b, evidence });
    const g = sm.get();
    assert.strictEqual(g.views.length, 1, '应该只有 1 条，实际 ' + g.views.length);
  });

  await okA('看法数量受 maxViews 限制', async () => {
    const sm = createSelfModel({ file: fileOf('cap'), cfg: { maxViews: 2 }, log: null });
    await sm.reflect({
      brain: fakeBrain({
        views: [
          { text: '第一件事的想法甲', confidence: 5 },
          { text: '第二件事的想法乙', confidence: 4 },
          { text: '第三件事的想法丙', confidence: 1 },
        ],
        styleHints: [],
        focus: '',
        mood: 'calm',
        memoryFixes: [],
      }),
      evidence,
    });
    assert.strictEqual(sm.get().views.length, 2);
  });

  await okA('bad-json 时不动状态', async () => {
    const sm = createSelfModel({ file: fileOf('bad'), log: null });
    const r = await sm.reflect({ brain: fakeBrain('我拒绝输出 JSON'), evidence });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(sm.get().views.length, 0);
  });

  await okA('模型调用异常不崩', async () => {
    const sm = createSelfModel({ file: fileOf('boom'), log: null });
    const r = await sm.reflect({
      brain: { _complete: async () => { throw new Error('network'); } },
      evidence,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'call-failed');
  });

  console.log('== 记忆修正 ==');
  await okA('相似的记忆被改写', async () => {
    const sm = createSelfModel({ file: fileOf('fix'), log: null });
    const items = [{ text: '他下周三要考生物化学', subject: 'o1', importance: 5, kind: 'promise' }];
    const r = await sm.reflect({
      brain: fakeBrain({
        views: [],
        styleHints: [],
        focus: '',
        mood: 'calm',
        memoryFixes: [{ from: '他下周三要考生物化学', to: '他下周四要考生物化学' }],
      }),
      evidence: { ...evidence, longterm: fakeLongterm(items) },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fixes.length, 1);
    assert.ok(items.some((i) => i.text === '他下周四要考生物化学'));
  });

  await okA('找不到对应记忆就不乱改', async () => {
    const sm = createSelfModel({ file: fileOf('fix2'), log: null });
    const items = [{ text: '他喜欢猫', subject: 'o1', importance: 3, kind: 'preference' }];
    const r = await sm.reflect({
      brain: fakeBrain({
        views: [],
        styleHints: [],
        focus: '',
        mood: 'calm',
        memoryFixes: [{ from: '完全不相干的一件往事描述', to: '改写成别的' }],
      }),
      evidence: { ...evidence, longterm: fakeLongterm(items) },
    });
    assert.strictEqual(r.fixes.length, 0);
    assert.strictEqual(items[0].text, '他喜欢猫');
  });

  console.log('== 落盘与节流 ==');
  await okA('写入文件后能重新读出来', async () => {
    const f = fileOf('persist');
    const sm = createSelfModel({ file: f, log: null });
    await sm.reflect({
      brain: fakeBrain({ views: [{ text: '记住要少说空话', confidence: 4 }], styleHints: ['少说空话'], focus: 'F', mood: 'good', memoryFixes: [] }),
      evidence,
    });
    const sm2 = createSelfModel({ file: f, log: null });
    assert.strictEqual(sm2.get().views.length, 1);
    assert.strictEqual(sm2.get().focus, 'F');
  });

  await okA('minHours 内不重复反思', async () => {
    const sm = createSelfModel({ file: fileOf('throttle'), cfg: { minHours: 4 }, log: null });
    await sm.reflect({ brain: fakeBrain({ views: [], styleHints: [], focus: '', mood: 'calm', memoryFixes: [] }), evidence });
    assert.strictEqual(sm.shouldReflect(), false);
    assert.strictEqual(sm.shouldReflect(Date.now() + 5 * 3600 * 1000), true);
  });

  await okA('关闭时直接跳过', async () => {
    const sm = createSelfModel({ file: fileOf('off'), cfg: { enabled: false }, log: null });
    const r = await sm.reflect({ brain: fakeBrain({}), evidence });
    assert.strictEqual(r.reason, 'disabled');
  });

  await okA('history 有上限', async () => {
    const sm = createSelfModel({ file: fileOf('hist'), cfg: { historyKeep: 2, minHours: 0 }, log: null });
    const b = fakeBrain({ views: [], styleHints: [], focus: '', mood: 'calm', memoryFixes: [] });
    await sm.reflect({ brain: b, evidence });
    await sm.reflect({ brain: b, evidence });
    await sm.reflect({ brain: b, evidence });
    assert.strictEqual(sm.get().history.length, 2);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : ''}`);
})();
