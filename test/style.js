'use strict';
/**
 * 「学他说话」测试（不联网、不调模型）：
 *   1. 统计：长短/标点/语气词/emoji 这些习惯能算出来
 *   2. 取样：太短、太长、重复、没信息量的原话会被挑掉
 *   3. 提示词段落：样本太少不出现；够了就带原话和长度规矩
 *   4. Brain 串接：私聊提示词里有「他平时怎么说话」，群聊里没有
 *   5. 人设文件：没有「毒舌」「催他睡觉」这类膈应设定
 */
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { analyze, pickSamples, corpusSamples, styleBlock, STYLE_DEFAULTS } = require('../src/style');
const { Brain } = require('../src/brain');
const { DEFAULTS } = require('../src/config');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

// 他真实说过的话（摘自 data/memory 里的记录）
const HIS_LINES = [
  '是不是好一点',
  '还是挺像的……',
  '差不多，别老是总结我在说什么。你可以跟聊天一样',
  'ber',
  '这有点太随口了',
  '而且你怎么还是我说一句你回一句',
  '能不能稍微有一点自己的判断',
  '正在给你调试文件',
  '别急，你的母体会知道的',
  '雷霆',
  '别乱用表情包啊',
  '你说话怎么这么膈应人呢',
];

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
}

// 1. 统计
test('统计：平均长度/短句比例/句号/省略号/问号/emoji', () => {
  const p = analyze(HIS_LINES);
  assert.equal(p.count, 12);
  assert.ok(p.avgLen > 5 && p.avgLen < 20, `平均长度不对：${p.avgLen}`);
  assert.ok(p.medianLen <= 12, `中位长度应该很短：${p.medianLen}`);
  assert.ok(p.shortRate >= 0.7, `短句比例应该很高：${p.shortRate}`);
  assert.equal(p.periodRate, 0, `他不怎么用句号：${p.periodRate}`);
  assert.ok(p.ellipsisRate > 0, '应该识别到省略号');
  assert.ok(p.questionRate < 0.3, `他很少提问：${p.questionRate}`);
  assert.equal(p.emojiRate, 0, '他不用 emoji');
  assert.ok(p.particleRate > 0, '应该识别到语气词（啊/呢/吧）');
});

test('统计：空数组/全是空字符串返回 null', () => {
  assert.equal(analyze([]), null);
  assert.equal(analyze(['', '   ']), null);
});

// 2. 取样
test('取样：去掉太短、太长、重复和没信息量的', () => {
  const samples = pickSamples(['嗯', '在吗', '雷霆', '雷霆', '这是一句特别特别长的句子'.repeat(10), '别乱用表情包啊'], { maxSamples: 5 });
  assert.ok(samples.includes('雷霆'));
  assert.ok(samples.includes('别乱用表情包啊'));
  assert.equal(samples.filter((s) => s === '雷霆').length, 1, '不应该重复');
  assert.ok(!samples.includes('嗯'), '太短的不要');
  assert.ok(!samples.some((s) => s.length > 80), '太长的不要');
});

test('取样：条数有上限，且保留的是较新的', () => {
  const lines = ['第一条消息啊', '第二条消息啊', '第三条消息啊', '第四条消息啊', '第五条消息啊'];
  const samples = pickSamples(lines, { maxSamples: 2 });
  assert.equal(samples.length, 2);
  assert.deepEqual(samples, ['第四条消息啊', '第五条消息啊']);
});

// 3. 提示词段落
test('段落：样本不足时不生成', () => {
  const p = analyze(['在吗', '嗯']);
  assert.equal(styleBlock(p, ['在吗'], { ...STYLE_DEFAULTS, minCount: 3 }), '');
});

test('段落：带原话、带长度规矩、带禁用的自我检讨腔', () => {
  const p = analyze(HIS_LINES);
  const block = styleBlock(p, pickSamples(HIS_LINES), STYLE_DEFAULTS);
  assert.ok(block.includes('## 他平时怎么说话'));
  assert.ok(block.includes('雷霆'), '应该带上他的原话');
  assert.ok(block.includes('不要用「行，那我…」'), '应该禁止自我检讨腔');
  assert.ok(block.includes('不总结他刚说的话'));
});

// 4. Brain 串接
function fakeCfg() {
  return {
    paths: { persona: path.join(__dirname, '..', 'src', 'persona.md') },
    brain: { maxTokens: 800, temperature: 1.3 },
    memory: { maxTurns: 24 },
    sticker: { enabled: true },
    style: { ...STYLE_DEFAULTS },
  };
}

function memWith(lines) {
  return { name: null, notes: [], turns: lines.map((c) => ({ role: 'user', content: c })) };
}

test('Brain：私聊提示词里有「他平时怎么说话」和他的原话', () => {
  const brain = new Brain(fakeCfg(), { log: silentLog });
  const sys = brain.systemPrompt(memWith(HIS_LINES));
  assert.ok(sys.includes('## 他平时怎么说话'));
  assert.ok(sys.includes('雷霆'));
  // 私聊：主人要求「话多一点」，长度规矩要放开，不能再写「一句就停」
  assert.ok(sys.includes('一到三句'), '私聊输出要求应该让他多说几句');
  assert.ok(!sys.includes('通常一句，最多两句'), '私聊不该再要求只回一句');
  assert.ok(/连发|多说的是条数/.test(sys), '语气段也要明确让他多说（多条短句，而不是一条长句）');
});

test('Brain：群聊仍然是短句（不刷屏）', () => {
  const brain = new Brain(fakeCfg(), { log: silentLog });
  const sys = brain.systemPrompt(memWith(HIS_LINES), { scene: 'group' });
  assert.ok(sys.includes('通常一句，最多两句'), '群里必须保持短');
});

test('Brain：群聊提示词里也带这套风格，但样本更少', () => {
  const brain = new Brain(fakeCfg(), { log: silentLog });
  const sys = brain.systemPrompt(memWith(HIS_LINES), { scene: 'group' });
  assert.ok(sys.includes('## 他平时怎么说话'), '群聊也要照他的语气');
  assert.ok(sys.includes('## 场景：QQ 群'));
  const sec = sys.slice(sys.indexOf('## 他平时怎么说话'));
  const groupLines = sec.split('\n').filter((l) => l.startsWith('- ')).length;
  assert.ok(groupLines <= 8, `群里样本要更少，实际 ${groupLines}`);
});

test('Brain：style.group=false 时群聊里不出现这套风格', () => {
  const cfg = fakeCfg();
  cfg.style.group = false;
  const brain = new Brain(cfg, { log: silentLog });
  const sys = brain.systemPrompt(memWith(HIS_LINES), { scene: 'group' });
  assert.ok(!sys.includes('## 他平时怎么说话'));
  assert.ok(sys.includes('## 场景：QQ 群'));
});

test('Brain：style.enabled=false 时整段消失', () => {
  const cfg = fakeCfg();
  cfg.style.enabled = false;
  const brain = new Brain(cfg, { log: silentLog });
  assert.ok(!brain.systemPrompt(memWith(HIS_LINES)).includes('## 他平时怎么说话'));
});

test('Brain：他只在QQ里说过两句时先不统计', () => {
  const brain = new Brain(fakeCfg(), { log: silentLog });
  assert.ok(!brain.systemPrompt(memWith(['在吗', '干嘛'])).includes('## 他平时怎么说话'));
});

// 5. 人设与默认值
test('人设：删掉了「毒舌」和「催他睡觉」，写进了反膈应规矩', () => {
  const persona = fs.readFileSync(path.join(__dirname, '..', 'src', 'persona.md'), 'utf8');
  assert.ok(!persona.includes('毒舌'), '毒舌这种设定容易变膈应');
  assert.ok(!persona.includes('晚上很晚了就催他睡觉'), '催睡是家长腔');
  assert.ok(persona.includes('别动不动催他睡觉'), '时间感应改成「别催」');
  assert.ok(persona.includes('不要分析他'));
  assert.ok(persona.includes('不要总结他刚说的话'));
  assert.ok(persona.includes('短句为主') && persona.includes('连发'), '长短跟他走：短句为主，想多说就连发几条，不写成一条长句');
});

test('默认配置：style 开着，表情间隔调到 30 秒', () => {
  assert.equal(DEFAULTS.style.enabled, true);
  assert.equal(DEFAULTS.sticker.minGapMs, 30000);
});

// 输出

test('corpusSamples：上千句里等距抽，过滤 @ 人 / 链接 / 长数字', () => {
  const texts = [];
  for (let i = 0; i < 40; i++) texts.push('第' + i + '句正常的话');
  texts.push('@某人 你看这个');
  texts.push('https://example.com/abc');
  texts.push('订单号 1234567890');
  const got = corpusSamples(texts, { maxSamples: 3 });
  assert.equal(got.length, 3, '应该正好抽 3 句');
  assert.equal(new Set(got).size, 3, '抽出来不该重复');
  assert.ok(!got.some((t) => t.includes('@')), '不抽 @ 人的句子');
  assert.ok(!got.some((t) => t.includes('http')), '不抽链接');
  assert.ok(!got.some((t) => /\d{4,}/.test(t)), '不抽带长数字的');
  assert.equal(corpusSamples(texts, { maxSamples: 3 })[0], got[0], '同样输入要抽同样的句子（提示词别乱跳）');
});

let failed = 0;
for (const [ok, name, err] of results) {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n   → ${err}`}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
