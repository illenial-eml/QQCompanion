'use strict';
/**
 * 「逐渐学他说话」测试（不联网、不调模型）：
 *   1. 什么样的句子会被收进样本库
 *   2. 去重 / 先进先出 / 落盘 / 重新载入
 *   3. 膈应清单：记一条、上限、落盘
 *   4. 趋势：最近 vs 早先，能看出变短
 *   5. 提示词：样本库的来源措辞、趋势句、「别这么说」段落
 *   6. Brain 串接：聊两句就会攒样本，他说「膈应」会把上一条回复记成反面教材
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StyleLearner, isLearnable } = require('../src/style-learn');
const { analyze, trend, styleBlock, STYLE_DEFAULTS } = require('../src/style');
const { Brain } = require('../src/brain');
const { MemoryStore } = require('../src/memory');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-learn-'));
}

async function main() {
  // 1. 收不收
  await test('收录规则：太短/太长/链接/命令/纯符号不收', () => {
    assert.equal(isLearnable('嗯'), false);
    assert.equal(isLearnable('https://example.com'), false);
    assert.equal(isLearnable('/clear'), false);
    assert.equal(isLearnable('。。。'), false);
    assert.equal(isLearnable('a'.repeat(200)), false);
    assert.equal(isLearnable('今天真累'), true);
    assert.equal(isLearnable('ber'), true);
  });

  // 2. 积累 / 去重 / 上限 / 落盘
  await test('积累：重复的挪到队尾，不重复占位', () => {
    const L = new StyleLearner({ log: silentLog, saveDelayMs: 0 });
    L.add('今天真累');
    L.add('ber');
    L.add('今天真累');
    assert.equal(L.texts().length, 2);
    assert.deepEqual(L.texts(), ['ber', '今天真累']);
  });

  await test('积累：超过上限先进先出', () => {
    const L = new StyleLearner({ log: silentLog, maxMessages: 3 });
    for (const t of ['一啊啊', '二啊啊', '三啊啊', '四啊啊']) L.add(t);
    assert.deepEqual(L.texts(), ['二啊啊', '三啊啊', '四啊啊']);
  });

  await test('落盘：写文件后能重新载入', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'learn.json');
    const L = new StyleLearner({ file, log: silentLog });
    L.add('今天真累');
    L.add('有点困了');
    L.flush();
    assert.ok(fs.existsSync(file));
    const L2 = new StyleLearner({ file, log: silentLog });
    assert.deepEqual(L2.texts(), ['今天真累', '有点困了']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('落盘：文件损坏时当空的，不崩', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'learn.json');
    fs.writeFileSync(file, '{坏掉的json', 'utf8');
    const L = new StyleLearner({ file, log: silentLog });
    assert.deepEqual(L.texts(), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 3. 膈应清单
  await test('膈应清单：记一条、去重、上限、能重新载入', () => {
    const dir = tmpDir();
    const negFile = path.join(dir, 'neg.json');
    const L = new StyleLearner({ negativeFile: negFile, log: silentLog, maxNegatives: 2 });
    L.addNegative('我觉得你现在不是在纠结格式，是在试我', '膈应');
    L.addNegative('我觉得你现在不是在纠结格式，是在试我', '膈应');
    assert.equal(L.negativeTexts().length, 1);
    L.addNegative('中午饭吃没吃', '膈应');
    L.addNegative('别把脑子改糊了', '膈应');
    assert.equal(L.negativeTexts().length, 2, '应该被上限截断');
    const L2 = new StyleLearner({ negativeFile: negFile, log: silentLog });
    assert.equal(L2.negativeTexts().length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 4. 趋势
  await test('趋势：最近明显变短能识别出来', () => {
    const older = Array.from({ length: 20 }, () => '这是一句比较长的话啦你说呢');
    const recent = Array.from({ length: 20 }, () => '短');
    const tr = trend([...older, ...recent]);
    assert.ok(tr, '应该有趋势结果');
    assert.ok(tr.delta < -0.5, `应该判为变短：${JSON.stringify(tr)}`);
    assert.equal(trend(['短', '短']), null, '样本太少不判断');
  });

  await test('提示词：趋势和「别这么说」都能进段落', () => {
    const p = analyze(Array.from({ length: 30 }, () => '好'));
    const block = styleBlock(p, ['好'], STYLE_DEFAULTS, {
      source: 'learned',
      trend: { olderAvg: 20, recentAvg: 6, delta: -0.7 },
      negatives: ['我觉得你是在试我'],
    });
    assert.ok(block.includes('攒下来的'), '应该用「平时攒出来的」措辞');
    assert.ok(block.includes('更短了'));
    assert.ok(block.includes('他嫌膈应过的话'));
    assert.ok(block.includes('我觉得你是在试我'));
  });

  // 5. Brain 串接
  await test('Brain：聊一句就攒一句，说「膈应」会把上一条回复记成反面教材', async () => {
    const dir = tmpDir();
    const cfg = {
      paths: { persona: path.join(__dirname, '..', 'src', 'persona.md'), data: dir, memory: path.join(dir, 'memory') },
      brain: { maxTokens: 100, temperature: 1.3, model: 'x', baseURL: 'http://127.0.0.1:1', apiKey: 'k', timeoutMs: 1000 },
      memory: { maxTurns: 24, maxChars: 12000, autoNotes: false },
      sticker: { enabled: false },
      style: { ...STYLE_DEFAULTS },
    };
    const memory = new MemoryStore({ dir: path.join(dir, 'memory'), maxTurns: 24, maxChars: 12000, log: silentLog });
    const brain = new Brain(cfg, { log: silentLog, memory });
    brain._complete = async () => '那今天就别动了';

    await brain.chat({ id: 'U1', userText: '今天真累' });
    assert.deepEqual(brain.learner.texts(), ['今天真累']);

    await brain.chat({ id: 'U1', userText: '你说话怎么这么膈应人呢' });
    assert.equal(brain.learner.texts().length, 2, '两句都要攒');
    assert.deepEqual(brain.learner.negativeTexts(), ['那今天就别动了']);

    // 攒了一些之后提示词里应该出现长期样本段
    for (let i = 0; i < 6; i++) brain.learner.add(`随便说一句第${i}句`);
    brain.learner.flush();
    const mem = memory.get('U1');
    const sys = brain.systemPrompt(mem);
    assert.ok(sys.includes('## 他平时怎么说话'));
    assert.ok(sys.includes('别这么说') || sys.includes('那今天就别动了'), '反面教材要进提示词');

    // 群聊不学
    const before = brain.learner.texts().length;
    await brain.chat({ id: 'G1', userText: '群里随便一句', scene: 'group' });
    assert.equal(brain.learner.texts().length, before, '群聊不应该攒样本');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('Brain：样本库文件是 data/style-learn.json，模式正确', () => {
    const dir = tmpDir();
    const cfg = {
      paths: { persona: path.join(__dirname, '..', 'src', 'persona.md'), data: dir },
      brain: { maxTokens: 100, temperature: 1.3 },
      memory: { maxTurns: 24 },
      sticker: { enabled: false },
      style: { ...STYLE_DEFAULTS },
    };
    const brain = new Brain(cfg, { log: silentLog });
    assert.ok(brain.learner);
    assert.ok(brain.learner.file.endsWith(path.join('style-learn.json')));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('Brain：第一次启动时从已有聊天记忆里补样本', () => {
    const dir = tmpDir();
    const memDir = path.join(dir, 'memory');
    const memory = new MemoryStore({ dir: memDir, maxTurns: 24, maxChars: 12000, log: silentLog });
    memory.addTurn('U9', 'user', '以前说过的一句');
    memory.addTurn('U9', 'assistant', '我回过的一句');
    const cfg = {
      paths: { persona: path.join(__dirname, '..', 'src', 'persona.md'), data: dir, memory: memDir },
      brain: { maxTokens: 100, temperature: 1.3 },
      memory: { maxTurns: 24 },
      sticker: { enabled: false },
      style: { ...STYLE_DEFAULTS },
    };
    const brain = new Brain(cfg, { log: silentLog, memory });
    assert.deepEqual(brain.learner.texts(), ['以前说过的一句'], '只补用户说的话');
    assert.ok(fs.existsSync(path.join(dir, 'style-learn.json')), '补完应该马上落盘');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 输出
  let failed = 0;
  for (const [ok, name, err] of results) {
    console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n   → ${err}`}`);
    if (!ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

main();
