'use strict';
/**
 * 真模型手感测试（手动跑，花 token）：`node test/real-style.js`
 * 用他真实的说话记录当上下文，看回复像不像、膈不膈应。
 */
const path = require('path');
const { loadConfig } = require('../src/config');
const { Brain } = require('../src/brain');
const { loadStickers } = require('../src/stickers');

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

const CASES = [
  '今天累死了',
  '雷霆',
  '帮我看看这段代码为啥报错',
  '在干嘛',
  '你这语气还是有点膈应',
];

const ANSWER_LINES = [...HIS_LINES];

(async () => {
  const cfg = loadConfig({ configPath: path.join(__dirname, '..', 'config.json') });
  cfg.log.level = 'error';
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const { list: stickers } = loadStickers({ root: cfg.root, cfg, log });

  const turns = ANSWER_LINES.map((c) => ({ role: 'user', content: c, at: Date.now() }));
  const mem = { id: 'STYLE-TEST', name: null, notes: [], turns };
  const memory = {
    get: () => mem,
    addTurn: (id, role, content) => { mem.turns.push({ role, content, at: Date.now() }); },
    setName: (id, name) => { if (name) mem.name = name; },
    setNote: () => {},
  };

  const brain = new Brain(cfg, { log, memory, stickers });
  const sys = brain.systemPrompt(mem);
  console.log('=== 提示词里的风格段 ===');
  console.log(sys.slice(sys.indexOf('## 他平时怎么说话'), sys.indexOf('## 输出要求')).trim());
  console.log('\n=== 回复 ===');

  let long = 0;
  for (const text of CASES) {
    const t0 = Date.now();
    const reply = await brain.chat({ id: mem.id, userText: text });
    const ms = Date.now() - t0;
    const len = [...reply].length;
    if (len > 30) long++;
    console.log(`\n他：${text}`);
    console.log(`你（${len}字 / ${ms}ms）：${reply.replace(/\[\[表情:[^\]]+\]\]/g, (m) => ` ${m}`)}`);
  }
  console.log(`\n超过 30 字的回复：${long}/${CASES.length}（越少越好）`);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
