'use strict';
// 受控自演化（P2 轻量版）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPersonaEvolve, scoreReply, CORRECTION_RE } = require('../src/persona-evolve');

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
const BASE = [
  '## 说话方式（最重要）',
  '',
  '- **短句为主**：一条 5~15 个字最像他。',
  '- **不要总结他刚说的话**，不要复述。',
  '- 心理活动用大白话说。',
  '',
  '## 别的',
  '',
  '不许编。',
].join('\n');

function sandbox(brainReply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-'));
  const personaPath = path.join(dir, 'persona.md');
  fs.writeFileSync(personaPath, BASE, 'utf8');
  const brain = {
    calls: 0,
    async _complete() {
      this.calls++;
      return typeof brainReply === 'function' ? brainReply() : brainReply;
    },
  };
  const evolve = createPersonaEvolve({
    cfg: { dir: path.join(dir, 'data') },
    log: silent,
    personaPath,
  });
  return { dir, personaPath, brain, evolve };
}

(async () => {
  console.log('收集偏差');

  await ok('他说「别老反问」会被记下来', async () => {
    const { evolve } = sandbox('');
    assert.ok(evolve.recordFeedback('别老反问我'));
    assert.strictEqual(evolve.feedbackList().length, 1);
  });

  await ok('普通聊天不记', async () => {
    const { evolve } = sandbox('');
    assert.ok(!evolve.recordFeedback('今天吃什么'));
    assert.strictEqual(evolve.feedbackList().length, 0);
  });

  await ok('「太书面了」「说人话」都算纠正', async () => {
    const { evolve } = sandbox('');
    evolve.recordFeedback('太书面了');
    evolve.recordFeedback('说人话');
    assert.strictEqual(evolve.feedbackList().length, 2);
  });

  await ok('同一句一分钟内不重复记', async () => {
    const { evolve } = sandbox('');
    evolve.recordFeedback('别这么说');
    evolve.recordFeedback('别这么说');
    assert.strictEqual(evolve.feedbackList().length, 1);
  });

  console.log('生成候选');

  await ok('模型给的候选只保留「原文里真实存在」的句子', async () => {
    const reply = JSON.stringify({
      rules: [
        { old: '- **短句为主**：一条 5~15 个字最像他。', new: '- **短句为主**：一条别超过 12 个字。', why: '他嫌长' },
        { old: '这句在原文里根本不存在', new: '改点什么', why: '编的' },
      ],
      reason: '他嫌句子长',
    });
    const { evolve, brain } = sandbox(reply);
    const r = await evolve.propose({ brain, personaText: BASE, feedback: [{ text: '别这么正式' }] });
    assert.strictEqual(r.rules.length, 1, JSON.stringify(r.rules));
    assert.strictEqual(r.reason, '他嫌句子长');
    assert.strictEqual(brain.calls, 1);
  });

  await ok('证据不足时候选为空', async () => {
    const { evolve, brain } = sandbox(JSON.stringify({ rules: [], reason: '证据还不够' }));
    const r = await evolve.propose({ brain, personaText: BASE, feedback: [] });
    assert.strictEqual(r.rules.length, 0);
  });

  await ok('模型输出不是 JSON 时抛错而不是改坏东西', async () => {
    const { evolve, brain } = sandbox('我觉得应该改得更可爱一点');
    let threw = false;
    try {
      await evolve.propose({ brain, personaText: BASE, feedback: [] });
    } catch (e) {
      threw = true;
    }
    assert.ok(threw);
  });

  await ok('applyRules 只替换指定的那句', async () => {
    const { evolve } = sandbox('');
    const out = evolve.applyRules(BASE, [
      { old: '- 心理活动用大白话说。', new: '- 心理活动就说「有点烦」这种。' },
    ]);
    assert.ok(out.includes('有点烦'));
    assert.ok(!out.includes('- 心理活动用大白话说。'));
    assert.ok(out.includes('不许编。'));
  });

  console.log('采纳与回滚');

  await ok('采纳会写人设 + 留版本 + 备份', async () => {
    const reply = JSON.stringify({
      rules: [{ old: '- **不要总结他刚说的话**，不要复述。', new: '- **不要总结、不要复述他的话**。', why: '更短' }],
      reason: '更短',
    });
    const { evolve, brain, personaPath, dir } = sandbox(reply);
    const p = await evolve.propose({ brain, personaText: BASE, feedback: [{ text: '短一点' }] });
    const cand = evolve.saveCandidate({
      rules: p.rules,
      reason: p.reason,
      personaText: evolve.applyRules(BASE, p.rules),
      basePersona: BASE,
    });
    const r = evolve.adopt({ id: cand.id });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(fs.readFileSync(personaPath, 'utf8').includes('不要复述他的话'));
    const vs = evolve.versions();
    assert.strictEqual(vs.length, 1);
    assert.ok(fs.existsSync(vs[0].backupFile));
    assert.ok(vs[0].backupFile.startsWith(dir));
  });

  await ok('回滚能一字不差退回上一版', async () => {
    const { evolve, personaPath } = sandbox('');
    const cand = evolve.saveCandidate({
      rules: [{ old: '- 心理活动用大白话说。', new: '- 心理活动短一点。', why: 'x' }],
      reason: 'x',
      personaText: BASE.replace('- 心理活动用大白话说。', '- 心理活动短一点。'),
      basePersona: BASE,
    });
    evolve.adopt({ id: cand.id });
    assert.ok(fs.readFileSync(personaPath, 'utf8').includes('心理活动短一点'));
    const r = evolve.rollback();
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(personaPath, 'utf8'), BASE);
  });

  await ok('没有版本时回滚给错误提示', async () => {
    const { evolve } = sandbox('');
    const r = evolve.rollback();
    assert.ok(!r.ok);
    assert.ok(r.error.includes('没有可回滚'));
  });

  await ok('候选按 id 取，不给 id 取最新', async () => {
    const { evolve } = sandbox('');
    const a = evolve.saveCandidate({ rules: [], reason: 'a', personaText: 'A', basePersona: BASE });
    const b = evolve.saveCandidate({ rules: [], reason: 'b', personaText: 'B', basePersona: BASE });
    assert.strictEqual(evolve.getCandidate(a.id).reason, 'a');
    assert.strictEqual(evolve.getCandidate().reason, 'b');
  });

  console.log('评分与取样');

  await ok('短的更口语的分数更低（更好）', () => {
    const good = scoreReply('有点烦\n懒得动');
    const bad = scoreReply('从某个维度来说，这或许是一种内耗，因此我建议你反思一下。');
    assert.ok(good.penalty < bad.penalty, good.penalty + ' vs ' + bad.penalty);
  });

  await ok('反问结尾会被扣分', () => {
    const a = scoreReply('行');
    const b = scoreReply('你觉得呢？');
    assert.ok(a.penalty < b.penalty);
  });

  await ok('取样只取主人的话、去重、限条数', () => {
    const { evolve } = sandbox('');
    const turns = [
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在呢' },
      { role: 'user', content: '在吗' },
      { role: 'user', content: '今天好累' },
      { role: 'user', content: '我明天考试' },
    ];
    const s = evolve.pickSamples({ memoryTurns: turns, limit: 2 });
    assert.deepStrictEqual(s, ['今天好累', '我明天考试']);
  });

  await ok('compare 旧新各说一遍并给分', async () => {
    const { evolve } = sandbox(() => '好');
    const rows = await evolve.compare({
      brain: { async _complete() { return '好'; } },
      samples: ['在吗'],
      oldPersona: BASE,
      newPersona: BASE + '\n新规则',
    });
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].oldScore.penalty >= 0);
    assert.ok(evolve.summarizeCompare(rows).includes('1/1'));
  });

  await ok('state 汇报三个数字', () => {
    const { evolve } = sandbox('');
    evolve.recordFeedback('说人话');
    evolve.saveCandidate({ rules: [], reason: 'x', personaText: 'X', basePersona: BASE });
    const s = evolve.state();
    assert.strictEqual(s.feedback, 1);
    assert.strictEqual(s.candidates, 1);
    assert.strictEqual(s.versions, 0);
  });

  await ok('正则不会把「别这么说」以外的日常话误判', () => {
    assert.ok(!CORRECTION_RE.test('今天天气不错'));
    assert.ok(!CORRECTION_RE.test('我吃了饭'));
  });

  console.log(`\n通过 ${pass}  失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
