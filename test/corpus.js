'use strict';
/**
 * 聊天记录导入测试（不联网、不调模型）：
 *   1. 解析 QQ 导出格式（时间 昵称(QQ号) + 内容）
 *   2. 解析昵称在前的格式、行内「昵称：内容」、纯粘贴
 *   3. 认出「我」的那几条（昵称 / QQ号 都能认）
 *   4. 过滤：表情占位、图片、链接、撤回、太长太短、重复
 *   5. 统计与存读 round-trip
 *   6. Brain：有聊天记录样本时，提示词用大样本的语气并带上其中的原话
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseChatText, selectMine, stats, loadCorpus, saveCorpus, corpusTexts, splitSpeaker,
} = require('../src/corpus');
const { Brain } = require('../src/brain');
const { STYLE_DEFAULTS } = require('../src/style');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

const QQ_EXPORT = `2026-10-20 13:02:11 小明(4018454540)
在干嘛呢

2026-10-20 13:02:30 老王(123456)
在打游戏

2026-10-20 13:02:40 小明(4018454540)
我饿了，等会去吃饭

2026-10-20 13:03:01 老王(123456)
[图片]

2026-10-20 13:03:20 小明(4018454540)
行
`;

const results = [];
function test(name, fn) {
  try { fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); }
}

test('解析：QQ 导出格式能认出说话人和内容', () => {
  const msgs = parseChatText(QQ_EXPORT, { me: ['小明'] });
  assert.equal(msgs.length, 4, `[图片] 这种占位不算消息，应该 4 条，实际 ${msgs.length}`);
  assert.equal(msgs[0].speaker, '小明(4018454540)');
  assert.equal(msgs[0].text, '在干嘛呢');
  assert.equal(msgs[0].mine, true);
  assert.equal(msgs[1].mine, false, '老王不是他');
  assert.equal(msgs[3].text, '行');
});

test('解析：昵称在前 / 行内标签 / 纯粘贴', () => {
  const a = parseChatText('小明 2026-10-20 13:02:11\n哈哈\n', { me: ['小明'] });
  assert.equal(a[0].speaker, '小明');
  assert.equal(a[0].text, '哈哈');
  assert.equal(a[0].mine, true);

  const b = parseChatText('小明：今天好累啊\n老王：早点睡\n', { me: ['小明'] });
  assert.equal(b.length, 2);
  assert.equal(b[0].text, '今天好累啊');
  assert.equal(b[0].mine, true);
  assert.equal(b[1].mine, false);

  const c = parseChatText('今天好累啊\n不想动\n', { allMine: true });
  assert.equal(c.length, 2);
  assert.ok(c.every((m) => m.mine));
});

test('解析：QQ号也能认（--me 写数字）', () => {
  const msgs = parseChatText(QQ_EXPORT, { me: ['4018454540'] });
  assert.equal(msgs.filter((m) => m.mine).length, 3);
});

test('过滤：表情/图片/链接/撤回/太长/太短/重复都去掉', () => {
  const raw = parseChatText(QQ_EXPORT, { me: ['小明'] });
  const mine = selectMine(raw, { maxMessages: 100, maxChars: 80 });
  assert.deepEqual(mine.map((m) => m.text), ['在干嘛呢', '我饿了，等会去吃饭', '行']);

  const messy = parseChatText(
    [
      '小明：看这个 https://example.com','小明：[表情]','小明：[图片]','小明：哈哈哈',
      '小明：哈哈哈','小明：撤回了一条消息','小明：这' + '很'.repeat(100),
    ].join('\n'),
    { me: ['小明'] }
  );
  const cleaned = selectMine(messy, { maxMessages: 100, maxChars: 80 });
  assert.deepEqual(cleaned.map((m) => m.text), ['哈哈哈']);
});

test('统计：总数/我的条数/平均长度', () => {
  const s = stats(parseChatText(QQ_EXPORT, { me: ['小明'] }));
  assert.equal(s.total, 4);
  assert.equal(s.mine, 3);
  assert.ok(s.avgLen > 2 && s.avgLen < 12);
});

test('splitSpeaker：昵称(QQ号) 拆得开', () => {
  assert.deepEqual(splitSpeaker('小明(4018454540)'), { name: '小明', uin: '4018454540' });
  assert.deepEqual(splitSpeaker('小明'), { name: '小明', uin: '' });
});

test('存读 round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  const file = path.join(dir, 'c.json');
  const msgs = [{ text: '在干嘛呢' }, { text: '我饿了，等会去吃饭' }];
  saveCorpus(file, { source: 'test.txt', messages: msgs });
  const back = loadCorpus(file);
  assert.equal(back.count, 2);
  assert.deepEqual(corpusTexts(back), ['在干嘛呢', '我饿了，等会去吃饭']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Brain 串接：聊天记录样本进提示词
function fakeCfg() {
  return {
    paths: { persona: path.join(__dirname, '..', 'src', 'persona.md'), data: os.tmpdir() },
    brain: { maxTokens: 800, temperature: 1.3 },
    memory: { maxTurns: 24 },
    sticker: { enabled: true },
    style: { ...STYLE_DEFAULTS },
  };
}

test('Brain：载入聊天记录后提示词里带上记录里的原话', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  const file = path.join(dir, 'style-corpus.json');
  const lines = [
    '在干嘛呢', '我饿了，等会去吃饭', '雷霆', '别乱用表情包啊', '今天真累',
    '你还挺会说话', '我先去忙了', '晚点聊', '别急，你的母体会知道的', '这有点太随口了',
    ...Array.from({ length: 12 }, (_, i) => `随便说一句第${i}条`),
  ];
  saveCorpus(file, { source: 'sample.txt', messages: lines.map((t) => ({ text: t })) });
  const cfg = fakeCfg();
  cfg.style.corpusPath = file;
  const brain = new Brain(cfg, { log: silentLog });
  const sys = brain.systemPrompt({ name: null, notes: [], turns: [] });
  assert.ok(sys.includes('## 他平时怎么说话'), '应该用聊天记录生成风格段');
  assert.ok(sys.includes('从聊天记录里来的'), '应该标明样本来自聊天记录');
  assert.ok(sys.includes('雷霆') || sys.includes('母体'), '应该带上记录里的原话');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Brain：聊天记录少于 20 条时退回用 QQ 里说过的话', () => {
  const cfg = fakeCfg();
  cfg.style.corpusPath = path.join(os.tmpdir(), `nope-${Date.now()}.json`);
  const brain = new Brain(cfg, { log: silentLog });
  const turns = ['小明在吗', '今天有点累', '你说话怎么这么膈应人'].map((c) => ({ role: 'user', content: c }));
  const sys = brain.systemPrompt({ name: null, notes: [], turns });
  assert.ok(sys.includes('## 他平时怎么说话'));
  assert.ok(!sys.includes('从聊天记录里来的'), '没有聊天记录时不该用记录样本');
  assert.ok(!sys.includes('第0条'), '不该把记录里的句子混进提示词');
});


test('Markdown 导出格式（微信记录导出工具给的 .md）能认出 me 是他自己说的', () => {
  const md = [
    '# 水群 · 微信聊天记录',
    '',
    '- 会话 ID：\`123@chatroom\`',
    '- 类型：群聊',
    '- 消息条数：**18012**',
    '',
    '---',
    '',
    '- \`2026-08-16 08:45\` **me**：我有A2的表',
    '- \`2026-08-16 08:45\` **王泽远**：我就认识你们几个了',
    '  ↳ 回复 王泽远: 有没有已经拉好的QQ群？',
    '- \`2026-08-16 08:45\`：[系统] "某人"已开启进群确认',
    '- \`2026-08-16 08:46\` **me**：进群验证记得开',
  ].join('\n');
  const parsed = parseChatText(md, { me: [] });
  assert.equal(parsed.length, 3, '系统消息、引用行、元信息都不该算消息');
  assert.equal(parsed[0].text, '我有A2的表');
  assert.equal(parsed[0].mine, true, 'me 要认成他自己说的');
  assert.equal(parsed[1].text, '我就认识你们几个了');
  assert.equal(parsed[1].mine, false);
  assert.equal(parsed[2].mine, true);
  const mine = selectMine(parsed, { maxMessages: 10 });
  assert.equal(mine.length, 2, '只有他自己那两句能当样本');
});

let failed = 0;
for (const [ok, name, err] of results) {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n   → ${err}`}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
